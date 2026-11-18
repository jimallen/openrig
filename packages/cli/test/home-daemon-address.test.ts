// workspaces-o9o.181: a CLI run with a temporary OPENRIG_HOME reached the live daemon (twice on 2026-11-18): with no daemon.json and
// no configured port, the CLI fell back to the built-in 127.0.0.1:7433, which on a seat's host is the live daemon. A home other
// than the default ~/.openrig now never falls back there: it resolves no daemon, says why, and sends nothing.
// Every row runs in a temporary home. The "default home" case uses a temporary user home, never the real one. Every request goes
// through a spy, so nothing here can reach a daemon.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DaemonClient, DaemonConnectionError } from "../src/client.js";
import { getDaemonStatus, statusGuardMessage, stopDaemon } from "../src/daemon-lifecycle.js";
import { homeWithoutDaemonAddress, isNonDefaultOpenRigHome, NO_HOME_DAEMON_ACTION, NO_HOME_DAEMON_URL } from "../src/home-daemon-address.js";
import { asLifecycleDeps } from "./helpers/mock-lifecycle-deps.js";
import { stubConfigStore } from "./helpers/stub-config-store.js";

let scratch = "";
const ADDRESS_ENV = ["OPENRIG_URL", "RIGGED_URL", "OPENRIG_PORT", "RIGGED_PORT", "OPENRIG_HOST", "RIGGED_HOST", "RIGGED_HOME"];

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "o181-"));
  for (const name of ADDRESS_ENV) vi.stubEnv(name, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** A fresh home with nothing in it: no daemon.json, no config.json. */
function emptyHome(): string {
  const home = path.join(scratch, "home");
  fs.mkdirSync(home, { recursive: true });
  vi.stubEnv("OPENRIG_HOME", home);
  return home;
}

describe("o9o.181: which homes are the default", () => {
  it("unset is the default; <user home>/.openrig is the default, also through a symlink; any other home is not", () => {
    const userHome = path.join(scratch, "user");
    fs.mkdirSync(path.join(userHome, ".openrig"), { recursive: true });
    vi.stubEnv("OPENRIG_HOME", undefined); // the hermetic setup sets a fixture home for every test
    expect(isNonDefaultOpenRigHome(userHome)).toBe(false);
    vi.stubEnv("OPENRIG_HOME", path.join(userHome, ".openrig"));
    expect(isNonDefaultOpenRigHome(userHome)).toBe(false);
    fs.symlinkSync(path.join(userHome, ".openrig"), path.join(scratch, "alias"));
    vi.stubEnv("OPENRIG_HOME", path.join(scratch, "alias"));
    expect(isNonDefaultOpenRigHome(userHome)).toBe(false);
    vi.stubEnv("OPENRIG_HOME", path.join(scratch, "elsewhere"));
    expect(isNonDefaultOpenRigHome(userHome)).toBe(true);
  });

  it("a non-default home names no daemon unless the environment or its own config names a port or host", () => {
    const home = emptyHome();
    expect(homeWithoutDaemonAddress()).toMatch(/^Daemon not running for OPENRIG_HOME .*never falls back to the default daemon at 127\.0\.0\.1:7433/);
    vi.stubEnv("OPENRIG_PORT", "28181");
    expect(homeWithoutDaemonAddress()).toBeNull();
    vi.stubEnv("OPENRIG_PORT", undefined);
    vi.stubEnv("OPENRIG_HOST", "127.0.0.2");
    expect(homeWithoutDaemonAddress()).toBeNull();
    vi.stubEnv("OPENRIG_HOST", undefined);
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ daemon: { port: 28182 } }));
    expect(homeWithoutDaemonAddress()).toBeNull();
    fs.rmSync(path.join(home, "config.json"));
    // A store that cannot say where its values came from: a non-default value is configured, the built-in one is not.
    expect(homeWithoutDaemonAddress({ configStore: stubConfigStore({ daemon: { port: 28183, host: "127.0.0.1" } }) })).toBeNull();
    expect(homeWithoutDaemonAddress({ configStore: stubConfigStore({ daemon: { port: 7433, host: "127.0.0.2" } }) })).toBeNull();
    expect(homeWithoutDaemonAddress({ configStore: stubConfigStore({ daemon: { port: 7433, host: "127.0.0.1" } }) })).not.toBeNull();
    // The default home keeps today's fallback: the same empty home, named as <user home>/.openrig, names no reason.
    const userHome = path.join(scratch, "user");
    fs.mkdirSync(path.join(userHome, ".openrig"), { recursive: true });
    vi.stubEnv("OPENRIG_HOME", path.join(userHome, ".openrig"));
    expect(homeWithoutDaemonAddress({ userHome })).toBeNull();
  });
});

describe("o9o.181: the client never sends to the built-in default from a home that names no daemon", () => {
  it("its address is the no-daemon address, and a request is refused before anything is sent", async () => {
    emptyHome();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}"));
    const client = new DaemonClient(undefined, { fetchImpl });
    expect(client.baseUrl).toBe(NO_HOME_DAEMON_URL);
    const error = await client.post("/api/queue/create", { body: "x" }).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonConnectionError);
    expect((error as DaemonConnectionError).message).toContain("Nothing was sent");
    expect((error as DaemonConnectionError).writeOutcome).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("controls: the home's own daemon.json, OPENRIG_URL and a configured port are all still used", () => {
    const home = emptyHome();
    fs.writeFileSync(path.join(home, "daemon.json"), JSON.stringify({ pid: process.pid, port: 28184, startedAt: "2026-11-18T00:00:00Z" }));
    expect(new DaemonClient().baseUrl).toBe("http://127.0.0.1:28184");
    fs.rmSync(path.join(home, "daemon.json"));
    vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:28185");
    expect(new DaemonClient().baseUrl).toBe("http://127.0.0.1:28185");
    vi.stubEnv("OPENRIG_URL", undefined);
    vi.stubEnv("OPENRIG_PORT", "28186");
    expect(new DaemonClient().baseUrl).toBe("http://127.0.0.1:28186");
  });
});

describe("o9o.181: daemon status and stop never probe the built-in default from a home that names no daemon", () => {
  const deps = (fetch: (url: string) => Promise<{ ok: boolean }>, extra: Record<string, unknown> = {}) => asLifecycleDeps({
    fetch, readFile: () => null, exists: () => false, isProcessAlive: () => false, ...extra,
  });

  it("status is stopped with the reason, and nothing is probed", async () => {
    emptyHome();
    const fetch = vi.fn(async () => ({ ok: true }));
    const status = await getDaemonStatus(deps(fetch));
    expect(status.state).toBe("stopped");
    expect(status.noHomeDaemon).toContain("names no daemon of its own");
    expect(fetch).not.toHaveBeenCalled();
    expect(statusGuardMessage(status)).toEqual({ fact: status.noHomeDaemon, consequence: expect.stringContaining("Nothing was sent"), action: NO_HOME_DAEMON_ACTION });
  });

  it("the wrong-home hint still applies, unprobed: a live sibling home keeps it unverified and names both paths", async () => {
    const home = emptyHome();
    const sibling = path.join(path.dirname(home), ".openrig-live");
    const fetch = vi.fn(async () => ({ ok: true }));
    const status = await getDaemonStatus(deps(fetch, {
      homeDir: home,
      listDir: () => [path.basename(home), ".openrig-live"],
      exists: (p: string) => p === path.join(sibling, "daemon.json"),
      readFile: (p: string) => (p === path.join(sibling, "daemon.json") ? JSON.stringify({ pid: 4242 }) : null),
      isProcessAlive: (pid: number) => pid === 4242,
    }));
    expect(status).toMatchObject({ state: "unverified", siblingHint: { resolvedHome: home, siblingHome: sibling } });
    expect(status.noHomeDaemon).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("control: with a configured port the configured target is probed, as before", async () => {
    emptyHome();
    vi.stubEnv("OPENRIG_PORT", "28187");
    const fetch = vi.fn(async (_url: string) => ({ ok: true }));
    const status = await getDaemonStatus(deps(fetch));
    expect(fetch.mock.calls.map((call) => call[0])).toContain("http://127.0.0.1:28187/healthz");
    expect(status.state).toBe("running");
  });

  it("stop has no target, and probes nothing", async () => {
    emptyHome();
    const fetch = vi.fn(async () => ({ ok: true }));
    expect(await stopDaemon(deps(fetch))).toBe("no-target");
    expect(fetch).not.toHaveBeenCalled();
  });
});
