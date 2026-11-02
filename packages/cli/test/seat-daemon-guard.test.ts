import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDaemonStatus, startDaemon, stopDaemon, type DaemonStatus } from "../src/daemon-lifecycle.js";
import { daemonCommand } from "../src/commands/daemon.js";
import { seatDaemonControlRefusal } from "../src/seat-daemon-guard.js";

// A seat does not control the daemon, and a daemon is not started without a named runtime location (incident 2026-11-02).
// The identity names and the verbs are restated here, not imported from the guard, so a name or verb dropped from the rule fails a row.
const preflightRun = vi.hoisted(() => vi.fn(async () => ({ ready: true, checks: [] })));
vi.mock("../src/daemon-lifecycle.js", async (original) => {
  const actual = await original<typeof import("../src/daemon-lifecycle.js")>();
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "stopped" })),
    startDaemon: vi.fn(async () => { throw new Error("startup reached"); }),
    stopDaemon: vi.fn(async () => "stopped"),
  };
});
vi.mock("../src/system-preflight.js", () => ({ SystemPreflight: class { run = preflightRun; }, quietPreflightExec: async () => "" }));

const IDENTITY_NAMES = ["OPENRIG_SESSION_NAME", "OPENRIG_NODE_ID", "RIGGED_SESSION_NAME", "RIGGED_NODE_ID"];
const SEAT_VALUE = "seat-value-that-must-not-be-printed@somerig";

let home: string;
let errors: string[];
let logs: string[];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "seat-daemon-guard-"));
  vi.stubEnv("OPENRIG_HOME", home);
  // A named runtime location on every platform, so the identity rows judge identity alone.
  vi.stubEnv("XDG_RUNTIME_DIR", join(home, "run"));
  errors = [];
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")); });
  vi.mocked(startDaemon).mockClear();
  vi.mocked(stopDaemon).mockClear();
  vi.mocked(getDaemonStatus).mockClear();
  preflightRun.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); process.exitCode = undefined; });

async function run(verb: string, ...extra: string[]): Promise<void> {
  await new Command().exitOverride().addCommand(daemonCommand()).parseAsync(["node", "rig", "daemon", verb, ...extra]);
}

describe("rig daemon start|stop from a seat", () => {
  describe.each(IDENTITY_NAMES)("with only %s set", (name) => {
    it.each(["start", "stop"])("%s is refused: exit 1, the cause and the operator named, nothing started or stopped", async (verb) => {
      vi.stubEnv(name, SEAT_VALUE);
      await run(verb);
      const message = errors.join("\n");
      expect(process.exitCode).toBe(1);
      expect(message).toContain(`rig daemon ${verb} is refused in a seat`);
      expect(message).toContain(name);
      expect(message).toContain("operator");
      expect(message, "a value is never printed").not.toContain(SEAT_VALUE);
      expect(startDaemon).not.toHaveBeenCalled();
      expect(stopDaemon).not.toHaveBeenCalled();
      expect(preflightRun, "refused before preflight").not.toHaveBeenCalled();
    });
  });

  it("names every identity variable that is set", async () => {
    for (const name of IDENTITY_NAMES) vi.stubEnv(name, SEAT_VALUE);
    await run("stop");
    for (const name of IDENTITY_NAMES) expect(errors.join("\n")).toContain(name);
  });

  it("an empty or blank identity variable is no identity: stop and start go on", async () => {
    for (const name of IDENTITY_NAMES) vi.stubEnv(name, "  ");
    await run("stop");
    expect(stopDaemon).toHaveBeenCalledTimes(1);
    await run("start");
    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(errors.join("\n")).not.toContain("refused in a seat");
  });

  it("outside a seat, stop and start reach the lifecycle (the guard is the only difference)", async () => {
    await run("stop");
    expect(stopDaemon).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
    await run("start");
    expect(preflightRun).toHaveBeenCalledTimes(1);
    expect(startDaemon).toHaveBeenCalledTimes(1);
  });

  it("status stays available to a seat: it reads (logs is judged by the verb census below)", async () => {
    for (const name of IDENTITY_NAMES) vi.stubEnv(name, SEAT_VALUE);
    await run("status");
    expect(getDaemonStatus).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toContain("Daemon stopped");
    expect(errors.join("\n")).not.toContain("refused in a seat");
    expect(process.exitCode).toBeUndefined();
  });

  it("every verb of `rig daemon` but status and logs is refused in a seat (a new verb must be guarded or listed here)", async () => {
    const verbs = daemonCommand().commands.map((c) => c.name());
    expect(verbs, "positive control: the verbs this test judges").toEqual(expect.arrayContaining(["start", "stop", "status", "logs"]));
    for (const name of IDENTITY_NAMES) vi.stubEnv(name, SEAT_VALUE);
    for (const verb of verbs.filter((v) => !["status", "logs"].includes(v))) {
      errors.length = 0;
      process.exitCode = undefined;
      await run(verb);
      expect(errors.join("\n"), verb).toContain(`rig daemon ${verb} is refused in a seat`);
      expect(process.exitCode, verb).toBe(1);
    }
  });
});

describe("rig daemon start names a runtime location for the core it will start", () => {
  const clear = () => {
    // No HOME, no XDG_*, no HC_SOCKET: refused on every platform, so this row does not depend on the host running the suite.
    for (const name of ["HOME", "XDG_RUNTIME_DIR", "XDG_STATE_HOME", "HC_SOCKET", "OPENRIG_HC_NO_START_CORE"]) vi.stubEnv(name, "");
  };
  it("is refused before preflight, naming the cause, when the env names no location", async () => {
    clear();
    await run("start");
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("refusing to start an hc core");
    expect(errors.join("\n")).toContain("HC_SOCKET");
    expect(preflightRun).not.toHaveBeenCalled();
    expect(startDaemon).not.toHaveBeenCalled();
  });
  it("goes on when HC_SOCKET names the core (positive control: the same env, one name added)", async () => {
    clear();
    vi.stubEnv("HC_SOCKET", join(home, "core.sock"));
    await run("start");
    expect(preflightRun).toHaveBeenCalledTimes(1);
    expect(startDaemon).toHaveBeenCalledTimes(1);
  });
  it("goes on when the daemon will not start a core (OPENRIG_HC_NO_START_CORE=1)", async () => {
    clear();
    vi.stubEnv("OPENRIG_HC_NO_START_CORE", "1");
    await run("start");
    expect(startDaemon).toHaveBeenCalledTimes(1);
  });
  it("judges identity first: a seat without a location is told it is a seat", async () => {
    clear();
    vi.stubEnv("OPENRIG_SESSION_NAME", SEAT_VALUE);
    await run("start");
    expect(errors.join("\n")).toContain("refused in a seat");
    expect(errors.join("\n")).not.toContain("refusing to start an hc core");
  });
});

describe("the unhealthy-daemon advice in `rig daemon status`", () => {
  const status: DaemonStatus = { state: "running", port: 7433, pid: 4242, healthy: false, reason: "unresponsive" };
  const unhealthy = () => vi.mocked(getDaemonStatus).mockResolvedValueOnce(status);
  it("tells a seat to report to the operator, and never recommends the command", async () => {
    unhealthy();
    vi.stubEnv("OPENRIG_NODE_ID", SEAT_VALUE);
    await run("status");
    const text = logs.join("\n");
    expect(text, "positive control: the unhealthy branch printed").toContain("UNHEALTHY");
    expect(text).toContain("report this to the operator");
    expect(text).not.toMatch(/rig daemon (stop|start)/);
  });
  it("still tells a person outside a seat how to restart it, from a shell outside any seat", async () => {
    unhealthy();
    await run("status");
    const text = logs.join("\n");
    expect(text).toContain("UNHEALTHY");
    expect(text).toContain("rig daemon stop && rig daemon start");
    expect(text).toContain("outside any seat");
    expect(text).not.toContain("report this to the operator");
  });
});

describe("seatDaemonControlRefusal, by verb", () => {
  const seat = { OPENRIG_NODE_ID: SEAT_VALUE };
  it.each(["start", "stop", "restart"])("%s is refused in a seat, naming the verb and the variable", (verb) => {
    const message = seatDaemonControlRefusal(verb, seat);
    expect(message).toContain(`rig daemon ${verb} is refused in a seat`);
    expect(message).toContain("OPENRIG_NODE_ID");
  });
  it.each(["status", "logs", "ps"])("%s is not a refused verb, in a seat", (verb) => {
    expect(seatDaemonControlRefusal(verb, seat)).toBeNull();
  });
  it.each(["start", "stop", "restart"])("%s is not refused outside a seat", (verb) => {
    expect(seatDaemonControlRefusal(verb, { PATH: "/bin", HOME: "/h", OPENRIG_HOME: "/oh", OPENRIG_RUNTIME: "terminal" })).toBeNull();
  });
});
