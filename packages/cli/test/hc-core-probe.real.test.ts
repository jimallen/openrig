import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveHcSocket } from "@openrig/daemon/hc";
import { hcCoreListening, hcCoreListeningSync } from "../src/hc-core-probe.js";
import { defaultHcLabels } from "../src/commands/whoami.js";
import { resolveSharedTerminal } from "../src/shared-tui.js";

const HC = spawnSync("sh", ["-c", "command -v hc"], { encoding: "utf8" }).stdout.trim();

/** Security review F6, on a PRIVATE core only (own HOME, XDG paths and HC_SESSION under one temp root, as shared-tui.real.test.ts):
 *  a CLI read of the core must not start one. The control is the unguarded `hc ls`, which does. */
describe.skipIf(!HC)("a CLI read never starts an hc core (private core)", () => {
  const root = mkdtempSync(join(tmpdir(), "hcprobe-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: join(root, "h"), HC_SESSION: `f6${process.pid}`,
    XDG_CONFIG_HOME: join(root, "c"), XDG_DATA_HOME: join(root, "d"), XDG_STATE_HOME: join(root, "s"), XDG_RUNTIME_DIR: join(root, "r"),
  };
  const saved = { ...process.env };
  const socket = () => resolveHcSocket(env);

  beforeAll(() => {
    for (const d of ["h", "c", "d", "s", "r"]) mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
    for (const k of Object.keys(process.env)) if (/^(HC_|XDG_)/.test(k) || k === "HOME") delete process.env[k];
    Object.assign(process.env, env);
  });
  afterAll(() => {
    spawnSync(HC, ["server", "stop"], { env, stdio: "ignore" });
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  });

  it("with no core: the probes say so, shared-tui and whoami refuse, and no core was started", async () => {
    expect(existsSync(socket())).toBe(false);
    expect(await hcCoreListening(env)).toBe(false);
    expect(hcCoreListeningSync(env)).toBe(false);
    await expect(resolveSharedTerminal("operator-human@kernel")).rejects.toThrow(/Cannot list hc terminals/);
    expect(() => defaultHcLabels("t1")).toThrow(/no hc core is listening/);
    expect(existsSync(socket())).toBe(false);
  });

  it("control: the unguarded `hc ls` starts a core in that same env, which is the hazard", () => {
    expect(spawnSync(HC, ["ls", "--json"], { env, encoding: "utf8" }).status).toBe(0);
    expect(existsSync(socket())).toBe(true);
  });

  it("with a core: the probes say so, and the reads work as before", async () => {
    expect(await hcCoreListening(env)).toBe(true);
    expect(hcCoreListeningSync(env)).toBe(true);
    const run = spawnSync(HC, ["run", "--bg", "--name", "kern", "--label", "openrig.seat=operator-human@kernel", "--json", "sh", "-c", "cat"], { env, encoding: "utf8" });
    expect(run.status).toBe(0);
    const address = (JSON.parse(run.stdout.trim().split("\n").pop()!) as { address: string }).address;
    await expect(resolveSharedTerminal("operator-human@kernel")).resolves.toBe(address);
    expect(defaultHcLabels(address)["openrig.seat"]).toBe("operator-human@kernel");
  });

  it("after the core is stopped, and with a socket-path file nothing listens behind, it is not a core", async () => {
    spawnSync(HC, ["server", "stop"], { env, stdio: "ignore" });
    expect(await hcCoreListening(env)).toBe(false);
    expect(hcCoreListeningSync(env)).toBe(false);
    rmSync(socket(), { force: true });
    writeFileSync(socket(), "");  // a leftover that is not a listening socket
    expect(await hcCoreListening(env)).toBe(false);
    expect(hcCoreListeningSync(env)).toBe(false);
  });
});
