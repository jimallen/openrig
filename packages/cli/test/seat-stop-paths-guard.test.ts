import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESTROY_CONFIRM_TOKEN, type DestroyDeps } from "../src/destroy-helpers.js";
import { destroyCommand } from "../src/commands/destroy.js";
import { ConfigStore } from "../src/config-store.js";
import { daemonCommand } from "../src/commands/daemon.js";
import { stopDaemon, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import { seatDaemonControlRefusal } from "../src/seat-daemon-guard.js";

// A seat stops the daemon by no path (review of 6f813a07, F1): `rig destroy` stops it, kills the listener and ends the seats, and
// every caller of stopDaemon shares one refusal. HC_* names are an operator's hc terminal, not a seat's identity. Names restated, not imported.
const SEAT_VALUE = "seat-value-that-must-not-be-printed@somerig";
const IDENTITY_NAMES = ["OPENRIG_SESSION_NAME", "OPENRIG_NODE_ID", "RIGGED_SESSION_NAME", "RIGGED_NODE_ID"];
let output: string[];
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "seat-stop-paths-"));
  vi.stubEnv("OPENRIG_HOME", join(home, "state"));
  vi.stubEnv("XDG_RUNTIME_DIR", join(home, "run"));
  output = [];
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { output.push(args.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { output.push(args.join(" ")); });
});
afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function destroyDeps(): DestroyDeps {
  return {
    stopDaemon: vi.fn(async () => {}),
    inspectListener: vi.fn(async () => ({ kind: "openrig" as const, healthy: true })),
    findListeningPid: vi.fn(() => 4242),
    killProcess: vi.fn(),
    exists: vi.fn(() => true),
    renamePath: vi.fn(),
    removePath: vi.fn(),
    mkdirp: vi.fn(),
    listManagedTmuxSessions: vi.fn(() => []),
    killTmuxSession: vi.fn(() => true),
    listManagedHcSeats: vi.fn(() => ["a@r"]),
    killHcSeat: vi.fn(async () => "killed" as const),
    sleep: vi.fn(async () => {}),
    now: vi.fn(() => new Date("2026-04-10T08:10:11Z")),
  };
}
const runDestroy = (deps: DestroyDeps) => new Command().exitOverride().addCommand(destroyCommand({ configStore: new ConfigStore(), destroyDeps: deps }))
  .parseAsync(["node", "rig", "destroy", "--state", "--yes", "--confirm", DESTROY_CONFIRM_TOKEN]);

function lifecycleDeps(): LifecycleDeps {
  return {
    spawn: vi.fn(() => { throw new Error("spawn reached"); }),
    fetch: vi.fn(async () => { throw new Error("fetch reached"); }),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => false),
  };
}

describe("rig destroy from a seat", () => {
  describe.each(IDENTITY_NAMES)("with %s set", (name) => {
    it("stops nothing: no daemon stop, no listener signal, no state removed, no seat ended; exit 1; the operator named; no value printed", async () => {
      vi.stubEnv(name, SEAT_VALUE);
      const deps = destroyDeps();
      await runDestroy(deps);
      expect(deps.stopDaemon).not.toHaveBeenCalled();
      expect(deps.killProcess).not.toHaveBeenCalled();
      expect(deps.removePath).not.toHaveBeenCalled();
      expect(deps.renamePath).not.toHaveBeenCalled();
      expect(deps.killHcSeat).not.toHaveBeenCalled();
      const text = output.join("\n");
      expect(process.exitCode).toBe(1);
      expect(text).toContain("rig destroy is refused in a seat");
      expect(text).toContain(name);
      expect(text).toContain("operator");
      expect(text).not.toContain(SEAT_VALUE);
    });
  });
  it("outside a seat it still stops the daemon (positive control: the same call, no identity)", async () => {
    const deps = destroyDeps();
    await runDestroy(deps);
    expect(deps.stopDaemon).toHaveBeenCalledTimes(1);
    expect(output.join("\n")).not.toContain("refused in a seat");
  });
});

describe("stopDaemon, for any caller", () => {
  it.each(IDENTITY_NAMES)("refuses in a seat (%s set) before it reads state, probes or signals", async (name) => {
    vi.stubEnv(name, SEAT_VALUE);
    const deps = lifecycleDeps();
    await expect(stopDaemon(deps)).rejects.toThrow("rig daemon stop is refused in a seat");
    expect(deps.readFile).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.kill).not.toHaveBeenCalled();
  });
  it("outside a seat it goes on into the real stop path (positive control: it fails on the missing state, not on a refusal)", async () => {
    await expect(stopDaemon(lifecycleDeps())).rejects.toThrow("Daemon state is missing");
  });
});

describe("HC_* names are an operator's hc terminal, not a seat's identity", () => {
  const HC = { HC_SCOPE: "scope-1", HC_TERMINAL_ID: "t7", HC_TERMINAL_SOCKET: "/x/term.sock" };
  it("the guard is silent for the hc terminal's three names and for a plain Terminal.app session", () => {
    for (const verb of ["start", "stop", "restart"]) {
      expect(seatDaemonControlRefusal(verb, HC), verb).toBeNull();
      expect(seatDaemonControlRefusal(verb, {}), verb).toBeNull();
    }
  });
  it.each(Object.keys(HC))("%s alone is not an identity", (name) => {
    expect(seatDaemonControlRefusal("stop", { [name]: "v" })).toBeNull();
    expect(seatDaemonControlRefusal("start", { [name]: "v" })).toBeNull();
  });
  it.each([["an hc terminal", HC], ["a plain session", {}]])("rig daemon stop from %s reaches the lifecycle", async (_label, env) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const deps = lifecycleDeps();
    await new Command().exitOverride().addCommand(daemonCommand(deps)).parseAsync(["node", "rig", "daemon", "stop"]).catch(() => undefined);
    expect(output.join("\n")).not.toContain("refused in a seat");
    expect(output.join("\n"), "the real stop path ran").toContain("Daemon state is missing");
  });
});
