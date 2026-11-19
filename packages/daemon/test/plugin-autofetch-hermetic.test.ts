// workspaces-xuy: every daemon a test starts asked GitHub for the openrig-core plugin release. createDaemon wired a real-fetch
// client into PluginVendorService.attemptAutoFetch, so each in-process daemon (41 test files) tried
// https://github.com/mvschwarz/openrig-plugins/releases/latest/download/openrig-core.tar.gz and the P37 fetch guard refused
// it (122 refusals in one full run). Daemons a test SPAWNS (spawnDaemonEntrypoint, the hermetic scaffold) run outside that guard,
// so theirs was a real request. Test runs now turn the auto-fetch off with OPENRIG_NO_PLUGIN_FETCH=1 (the setup sets it for
// in-process daemons, the two env builders for spawned ones), and a test that wants the fetch path injects its own client.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { createDaemon } from "../src/startup.js";
import { PluginVendorService, type HttpClient, type PluginVendorFs } from "../src/domain/plugin-vendor-service.js";
import { testDaemonEnv } from "./helpers/daemon-entrypoint.js";
import { prepareHermeticEnv } from "./helpers/hermetic-env.js";

const SWITCH = "OPENRIG_NO_PLUGIN_FETCH";
const RELEASE_URL = "https://github.com/mvschwarz/openrig-plugins/releases/latest/download/openrig-core.tar.gz";
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Attempt { url: string; stack: string }

/** Start an in-process daemon in a private home, recording every non-loopback request it makes (through the P37 guard, which
 *  refuses it, so nothing leaves the machine) and every plugin-vendor fetch line it logs. */
async function startDaemon(opts: { pluginReleaseClient?: HttpClient | null } = {}): Promise<{ attempts: Attempt[]; fetchLogs: string[] }> {
  const root = mkdtempSync(join(os.tmpdir(), "xuy-autofetch-"));
  roots.push(root);
  vi.stubEnv("OPENRIG_HOME", root);
  vi.stubEnv("OPENRIG_NO_KERNEL", "1");
  vi.spyOn(os, "homedir").mockReturnValue(root);
  const attempts: Attempt[] = [];
  const guarded = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const host = new URL(url).hostname;
    if (!["127.0.0.1", "::1", "localhost", "[::1]"].includes(host)) attempts.push({ url, stack: new Error("attempt").stack ?? "" });
    return guarded(input, init);
  });
  const fetchLogs: string[] = [];
  const log = console.log;
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.includes("[plugin-vendor] fetch")) fetchLogs.push(line);
    else log(...args);
  });
  const { db } = await createDaemon({ dbPath: ":memory:", tmuxExec: async () => "", ...opts });
  db.close();
  return { attempts, fetchLogs };
}

const report = (attempts: Attempt[]) => attempts.map((a) => `${a.url}\n${a.stack}`).join("\n\n");

describe("workspaces-xuy: a test daemon never asks GitHub for the plugin release", () => {
  it("the suite's setup turns the plugin auto-fetch off", () => {
    expect(process.env[SWITCH]).toBe("1");
  });

  it("an in-process daemon under the suite's setup makes no request for the plugin release and logs no fetch", async () => {
    const { attempts, fetchLogs } = await startDaemon();
    expect(attempts, report(attempts)).toEqual([]);
    expect(fetchLogs).toEqual([]);
  }, 60_000);

  it("positive control: with the switch cleared, the same daemon does attempt the release (the guard refuses it), so the row above can see one", async () => {
    vi.stubEnv(SWITCH, "");
    const { attempts, fetchLogs } = await startDaemon();
    expect(attempts.map((a) => a.url)).toEqual([RELEASE_URL]);
    expect(fetchLogs).toHaveLength(1);
    expect(fetchLogs[0]).toContain("FETCH GUARD (P37)");
  }, 60_000);

  it("a client injected into createDaemon is the one asked, whatever the switch says, and no real request is made", async () => {
    const asked: string[] = [];
    const client: HttpClient = async (url) => { asked.push(url); return { ok: false, status: 404 }; };
    const { attempts, fetchLogs } = await startDaemon({ pluginReleaseClient: client });
    expect(asked).toEqual([RELEASE_URL]);
    expect(attempts, report(attempts)).toEqual([]);
    expect(fetchLogs).toEqual(["[openrig] [plugin-vendor] fetch openrig-core returned 404 (repo empty or release not published yet); falling back to vendored"]);
  }, 60_000);

  it("PluginVendorService with no client makes no request and logs nothing", async () => {
    const logged: unknown[][] = [];
    const service = new PluginVendorService({
      vendoredAssetsDir: "/nonexistent/assets",
      userPluginsDir: "/nonexistent/plugins",
      fs: {} as PluginVendorFs,
      httpClient: null,
      logger: (...args) => { logged.push(args); },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await service.attemptAutoFetch("openrig-core");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
  });

  it("a daemon a test spawns gets the switch from spawnDaemonEntrypoint's env, whatever the caller's env says", () => {
    const env = testDaemonEnv({ home: "/tmp/xuy-home" }, 45_678, { PATH: process.env["PATH"] ?? "", [SWITCH]: "0" });
    expect(env[SWITCH]).toBe("1");
  });

  it("a scenario daemon gets the switch from the hermetic scaffold's env, whatever the inherited env says", () => {
    const scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env["PATH"] ?? "", [SWITCH]: "0" } });
    try {
      expect(scaffold.env[SWITCH]).toBe("1");
    } finally {
      scaffold.cleanup();
    }
  });
});
