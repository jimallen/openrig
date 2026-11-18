// workspaces-o9o.181, re-fix after verify-sec's FAIL at e31dbef30: ONE resolver says which daemon a home means, and every
// path asks it BEFORE any probe, request or bind: doctor, the preflight, every start (rig daemon start, rig start, rig up,
// auto-start), crash-cart and destroy. A home other than ~/.openrig that names no daemon touches nothing on the default
// port 127.0.0.1:7433. Every probe, bind, lock or signal here is a spy that throws or records, so nothing here can reach a
// daemon or open a socket: a path that would probe fails on the spy's sentinel instead.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore } from "../src/config-store.js";
import { homeBindRefusal, NO_HOME_BIND_ACTION, resolveHomeDaemon } from "../src/home-daemon-address.js";
import { runDoctorChecks, type DoctorDeps } from "../src/commands/doctor.js";
import { SystemPreflight } from "../src/system-preflight.js";
import { startDaemon } from "../src/daemon-lifecycle.js";
import { executeDestroy, type DestroyDeps, type DestroyPlan } from "../src/destroy-helpers.js";
import { crashCartDaemonTarget } from "../src/commands/crash-cart.js";
import { destroyCommand } from "../src/commands/destroy.js";
import { DESTROY_CONFIRM_TOKEN } from "../src/destroy-helpers.js";
import { Command } from "commander";
import { NO_HOME_DAEMON_URL } from "../src/home-daemon-address.js";
import { asLifecycleDeps } from "./helpers/mock-lifecycle-deps.js";
import { stubConfigStore } from "./helpers/stub-config-store.js";

let scratch = "";
const ADDRESS_ENV = ["OPENRIG_URL", "RIGGED_URL", "OPENRIG_PORT", "RIGGED_PORT", "OPENRIG_HOST", "RIGGED_HOST", "RIGGED_HOME", "OPENRIG_BIND_HOST"];

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "o181b-"));
  for (const name of ADDRESS_ENV) vi.stubEnv(name, undefined);
  vi.stubEnv("OPENRIG_HOME", scratch); // a non-default home with nothing in it: no daemon.json, no config.json
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const PROBED = "PROBED: a path reached a daemon probe";

describe("o9o.181: the one resolver", () => {
  it("names explicit, then recorded, then configured; a non-default home naming none means no daemon", () => {
    expect(resolveHomeDaemon({ explicitUrl: "http://127.0.0.1:28190" })).toEqual({ kind: "explicit", url: "http://127.0.0.1:28190" });
    expect(resolveHomeDaemon({ recordedUrl: "http://127.0.0.1:28191" })).toEqual({ kind: "recorded", url: "http://127.0.0.1:28191" });
    expect(resolveHomeDaemon()).toMatchObject({ kind: "none", reason: expect.stringContaining("names no daemon of its own") });
    vi.stubEnv("OPENRIG_PORT", "28192");
    expect(resolveHomeDaemon()).toEqual({ kind: "configured", host: "127.0.0.1", port: 28192 });
  });

  it("an unreadable config means no daemon for a non-default home, and keeps the built-in fallback for the default home", () => {
    const broken = { resolve: () => { throw new Error("unreadable"); } };
    // A store that cannot say its source and whose resolve throws: nothing is configured.
    expect(resolveHomeDaemon({ configStore: broken }).kind).toBe("none");
    const userHome = path.join(scratch, "user");
    fs.mkdirSync(path.join(userHome, ".openrig"), { recursive: true });
    vi.stubEnv("OPENRIG_HOME", path.join(userHome, ".openrig"));
    expect(resolveHomeDaemon({ configStore: broken, userHome })).toEqual({ kind: "configured", host: "127.0.0.1", port: 7433 });
  });

  it("a port source that says configured while the config itself cannot be read: still no daemon for a non-default home", () => {
    // Reaches the resolver's unreadable-config branch (the row above stops earlier, at "nothing is configured"): the env names
    // a port, but resolving the config throws (a corrupt config.json beside OPENRIG_PORT). Never the built-in 7433.
    const halfBroken = {
      resolve: () => { throw new Error("config.json: unexpected token"); },
      resolveWithSource: (_key: string) => ({ value: 28202, source: "env" as const, defaultValue: 7433 }),
    };
    expect(resolveHomeDaemon({ configStore: halfBroken }).kind).toBe("none");
  });

  it("start: a non-default home needs a port of its own; a configured port or an explicit --port is enough; a host is not", () => {
    expect(homeBindRefusal()).toMatch(/names no daemon port of its own.*never starts a daemon on, or probes, the default port/);
    expect(homeBindRefusal({ explicitPort: true })).toBeNull();
    vi.stubEnv("OPENRIG_HOST", "127.0.0.2");
    expect(homeBindRefusal()).not.toBeNull();
    vi.stubEnv("OPENRIG_PORT", "28193");
    expect(homeBindRefusal()).toBeNull();
  });
});

describe("o9o.181: doctor asks the resolver before any probe", () => {
  // The sections doctor reads, as doctor.test.ts gives them.
  const doctorConfig = (port: number) => ({
    daemon: { port, host: "127.0.0.1" },
    db: { path: "/tmp/openrig/openrig.sqlite" },
    transcripts: { enabled: true, path: "/tmp/openrig/transcripts", lines: 1000, pollIntervalSeconds: 2 },
  });
  const baseDeps = (over: Partial<DoctorDeps>): DoctorDeps => ({
    exists: () => true, baseDir: "/install/cli/dist", readFile: () => null,
    exec: (cmd: string) => (cmd === "hc --version" ? "hc 0.1.16\n" : ""),
    checkPort: async () => { throw new Error(PROBED); },
    configStore: stubConfigStore(doctorConfig(7433)),
    platform: "darwin", mkdirp: () => {}, checkWritable: () => {},
    ...over,
  });

  it("a home that names no daemon fails the port check with the reason, and probes nothing (no bind check, no healthz)", async () => {
    const checkPort = vi.fn(async () => { throw new Error(PROBED); });
    const fetch = vi.fn(async (_url: string) => { throw new Error(PROBED); });
    const result = await runDoctorChecks(baseDeps({ checkPort, fetch })).portCheck;
    expect(result).toMatchObject({ name: "port", status: "fail", reason: expect.stringContaining("names no daemon of its own") });
    expect(checkPort).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("an explicit OPENRIG_URL is the daemon this home means: doctor asks it, not the default port", async () => {
    vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:28194");
    const checkPort = vi.fn(async () => { throw new Error(PROBED); });
    const fetch = vi.fn(async (_url: string) => ({ ok: true }));
    const result = await runDoctorChecks(baseDeps({ checkPort, fetch })).portCheck;
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(["http://127.0.0.1:28194/healthz"]);
    expect(checkPort).not.toHaveBeenCalled();
    expect(result.status).toBe("pass");
  });

  it("this home's recorded endpoint is the daemon it means: doctor asks it", async () => {
    const fetch = vi.fn(async (_url: string) => ({ ok: true }));
    const result = await runDoctorChecks(baseDeps({ fetch, recordedDaemonUrl: () => "http://127.0.0.1:28195" })).portCheck;
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(["http://127.0.0.1:28195/healthz"]);
    expect(result.status).toBe("pass");
  });

  it("control: a configured port is bind-checked as before", async () => {
    const checkPort = vi.fn(async (_port: number, _host: string) => true);
    const store = Object.assign(stubConfigStore(doctorConfig(28196)), {
      resolveWithSource: (_key: string) => ({ value: 28196, source: "env" as const, defaultValue: 7433 }),
    });
    const result = await runDoctorChecks(baseDeps({ checkPort, configStore: store })).portCheck;
    expect(checkPort).toHaveBeenCalledWith(28196, "127.0.0.1");
    expect(result.status).toBe("pass");
  });
});

describe("o9o.181: the preflight (rig preflight, start, up, auto-start, daemon start) asks the resolver before any probe", () => {
  const preflight = (getDaemonStatus: () => Promise<never>) => new SystemPreflight({
    exec: async (cmd: string) => (cmd.startsWith("hc") ? "hc 0.1.16\n" : ""),
    readHcHello: async () => ({ kind: "no_core", detail: "no core in this test" }),
    configStore: new ConfigStore(),
    getDaemonStatus,
    openrigHome: scratch,
  });

  it("a home that names no port fails the port check with the reason; the daemon status is never read, no port probed", async () => {
    const status = vi.fn(async (): Promise<never> => { throw new Error(PROBED); });
    const result = await preflight(status).run();
    expect(status).not.toHaveBeenCalled();
    expect(result.ready).toBe(false);
    expect(result.checks.find((c) => c.name === "port_available")).toMatchObject({
      ok: false, error: expect.stringContaining("names no daemon port of its own"), fix: NO_HOME_BIND_ACTION,
    });
  });

  it("control: an explicit --port goes on to the port check (here the status read, which throws its sentinel)", async () => {
    const status = vi.fn(async (): Promise<never> => { throw new Error(PROBED); });
    await expect(preflight(status).run({ port: 28197, host: "127.0.0.1", portExplicit: true })).rejects.toThrow(PROBED);
    expect(status).toHaveBeenCalledTimes(1);
  });
});

describe("o9o.181: every start refuses before the home is touched, the lock is taken, or anything is probed", () => {
  it("startDaemon in a home that names no port throws the refusal and takes no lock", async () => {
    const acquireStartLock = vi.fn(() => { throw new Error(PROBED); });
    const fetch = vi.fn(async (_url: string) => { throw new Error(PROBED); });
    const deps = asLifecycleDeps({ acquireStartLock, fetch, readFile: () => null, exists: () => false, isProcessAlive: () => false });
    await expect(startDaemon({ port: 7433 }, deps)).rejects.toThrow(/names no daemon port of its own[\s\S]*OPENRIG_PORT/);
    expect(acquireStartLock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("control: an explicit --port goes on (here to the lock, which throws its sentinel)", async () => {
    const acquireStartLock = vi.fn(() => { throw new Error(PROBED); });
    const deps = asLifecycleDeps({ acquireStartLock, readFile: () => null, exists: () => false, isProcessAlive: () => false });
    await expect(startDaemon({ port: 28198, portExplicit: true }, deps)).rejects.toThrow(PROBED);
    expect(acquireStartLock).toHaveBeenCalledTimes(1);
  });
});

describe("o9o.181: destroy never probes or signals a listener for a home that names no daemon", () => {
  it("no listener is inspected, looked up or killed, and the port reads clear", async () => {
    const inspectListener = vi.fn(async () => ({ kind: "openrig" as const }));
    const findListeningPid = vi.fn(() => 4242);
    const killProcess = vi.fn(() => {});
    const plan: DestroyPlan = {
      scope: "all", backup: false, stateRoot: scratch, daemonHost: "127.0.0.1", daemonPort: 7433,
      noDaemon: "Daemon not running for OPENRIG_HOME: it names no daemon of its own.",
      managedTmuxSessions: [], managedHcSeats: [], seatEnumerationFailures: [], targets: [], warnings: [],
    };
    const deps: DestroyDeps = {
      stopDaemon: async () => {}, inspectListener, findListeningPid, killProcess,
      exists: () => false, renamePath: () => {}, removePath: () => {}, mkdirp: () => {},
      listManagedTmuxSessions: () => [], listManagedHcSeats: () => [], killHcSeat: async () => "missing",
      sleep: async () => {}, now: () => new Date("2026-11-18T00:00:00Z"),
    };
    const result = await executeDestroy(plan, deps);
    expect(inspectListener).not.toHaveBeenCalled();
    expect(findListeningPid).not.toHaveBeenCalled();
    expect(killProcess).not.toHaveBeenCalled();
    expect(result.warnings.join("\n")).toContain("no listener was probed or signalled");
  });
});

describe("o9o.181: crash-cart probes the daemon this home means, never its own 127.0.0.1:7433 default", () => {
  it("a home that names no daemon gets the no-daemon address, and its probe is refused without a send", async () => {
    const send = vi.fn(async (_url: string) => new Response("{}"));
    const target = crashCartDaemonTarget(undefined, send);
    expect(target.openrigUrl).toBe(NO_HOME_DAEMON_URL);
    const error = await target.fetch(`${target.openrigUrl}/healthz`).then(() => null, (e: unknown) => e);
    expect(error).toMatchObject({ code: "ECONNREFUSED" });
    expect(send).not.toHaveBeenCalled();
  });

  it("controls: this home's daemon.json, then OPENRIG_URL, then a configured port, each sent to as given", async () => {
    const send = vi.fn(async (_url: string) => new Response("{}"));
    expect(crashCartDaemonTarget({ port: 28199 }, send).openrigUrl).toBe("http://127.0.0.1:28199");
    vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:28200");
    expect(crashCartDaemonTarget({ port: 28199 }, send).openrigUrl).toBe("http://127.0.0.1:28200");
    vi.stubEnv("OPENRIG_URL", undefined);
    vi.stubEnv("OPENRIG_PORT", "28201");
    const configured = crashCartDaemonTarget(undefined, send);
    expect(configured.openrigUrl).toBe("http://127.0.0.1:28201");
    await configured.fetch(`${configured.openrigUrl}/healthz`);
    expect(send.mock.calls.map((c) => c[0])).toEqual(["http://127.0.0.1:28201/healthz"]);
  });
});

describe("o9o.181: rig destroy plans no daemon for a home that names none (the one resolver, end to end)", () => {
  it("the plan names no daemon, and no listener is inspected, looked up or killed", async () => {
    const inspectListener = vi.fn(async () => ({ kind: "openrig" as const }));
    const findListeningPid = vi.fn(() => 4242);
    const killProcess = vi.fn(() => {});
    const destroyDeps: DestroyDeps = {
      stopDaemon: async () => {}, inspectListener, findListeningPid, killProcess,
      exists: () => false, renamePath: () => {}, removePath: () => {}, mkdirp: () => {},
      listManagedTmuxSessions: () => [], listManagedHcSeats: () => [], killHcSeat: async () => "missing",
      sleep: async () => {}, now: () => new Date("2026-11-18T00:00:00Z"),
    };
    const printed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...line: unknown[]) => { printed.push(line.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...line: unknown[]) => { printed.push(line.join(" ")); });
    const program = new Command();
    program.exitOverride();
    // The store holds only the built-in values (it cannot say where they came from): this home names no daemon.
    program.addCommand(destroyCommand({ configStore: stubConfigStore({
      daemon: { port: 7433, host: "127.0.0.1" }, db: { path: path.join(scratch, "openrig.sqlite") },
      transcripts: { enabled: true, path: path.join(scratch, "transcripts"), lines: 1000, pollIntervalSeconds: 2 },
    }), destroyDeps }));
    await program.parseAsync(["node", "rig", "destroy", "--state", "--yes", "--confirm", DESTROY_CONFIRM_TOKEN]);
    expect(inspectListener).not.toHaveBeenCalled();
    expect(findListeningPid).not.toHaveBeenCalled();
    expect(killProcess).not.toHaveBeenCalled();
    expect(printed.join("\n")).toContain("daemon: none (this OPENRIG_HOME names no daemon of its own");
  });
});
