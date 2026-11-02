// hc cutover (W42, 2026-11-01): the cutover warning. 0.1.16 on PATH, a running holderless 0.1.15 core, then `rig up --existing`: every
// seat read `hc refused <seat>: unavailable`. Measured cause (private cores, Linux aarch64, releases 0.1.15 and 0.1.16, each unpacked
// from its published archive with the sha256 of releases.herdr.dev/core/<version>/manifest.json checked): the core starts its holder
// lazily, on the first launch, by running the program file it was STARTED FROM. When that file was replaced while the core ran (an hc
// update, the app's update, an installer), the holder is the new file's build and the core refuses it: kind `unavailable`, "no holder:
// holder build ... differs from core build ...". A core that already has a holder is unaffected. A different `hc` earlier on PATH than
// the core's own file is unaffected too. The host never contacts the core's file by name; it is the core that re-runs it.
//
// Skipped unless OPENRIG_TEST_HC_VERSION_BINS names a folder holding `bin-0.1.15/herdr-core` and `bin-0.1.16/herdr-core` (the layout
// hc-version-swap.real.test.ts uses), and off Linux (the replaced-file mechanism, "(deleted)", was measured there only).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HcClient, type HcTerminal } from "../src/adapters/hc-client.js";
import { HcHost, hcTerminalName } from "../src/adapters/hc-host.js";
import { assertPrivateHcEnv, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

const BINS = process.env["OPENRIG_TEST_HC_VERSION_BINS"];
const release = (version: string): string => join(BINS ?? "", `bin-${version}`, "herdr-core");
const have = BINS !== undefined && ["0.1.15", "0.1.16"].every((v) => existsSync(release(v)));

describe.skipIf(!have || process.platform !== "linux")("a launch on a real core whose hc program file was replaced while it ran", () => {
  let scratch: HcScratch | null = null;
  let dir: string | null = null;
  afterEach(() => {
    scratch?.cleanup();
    scratch = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  /** A core started from a copy of `version` that this test owns, so the test can replace the file the core was started from. */
  const begin = (version: string) => {
    dir = mkdtempSync(join(tmpdir(), "hcw42-"));
    const file = join(dir, "hc");
    copyFileSync(release(version), file);
    scratch = startHcScratch({ hcBin: file });
    const client = new HcClient(scratch.socketPath);
    const host = new HcHost(client, { daemonEnv: { PATH: process.env["PATH"], HOME: scratch.home, SHELL: "/bin/sh" } });
    /** What an installer does: a new file renamed over the old one, the way `hc update` and the app replace it. */
    const replaceWith = (other: string): void => { copyFileSync(release(other), `${file}.new`); renameSync(`${file}.new`, file); };
    return { file, client, host, replaceWith, scratch };
  };
  const status = async (client: HcClient) => client.call<{ version: string; holder: unknown; holders: unknown[]; live: number }>("server.status");
  const live = async (client: HcClient) => (await client.call<{ terminals: HcTerminal[] }>("terminal.list")).terminals.map((t) => t.name);

  it.each([["0.1.15", "0.1.16"], ["0.1.16", "0.1.15"]])("a holderless %s core, its file replaced by %s: the launch says no holder, names the fix, and the fix works", async (from, to) => {
    const { client, host, replaceWith, scratch: s } = begin(from);
    expect((await status(client)).holder).toBeNull();           // holderless, as `hc server status` or `server start` leave a core
    replaceWith(to);
    const result = await host.createSession("qa@rig");
    expect(result).toMatchObject({ ok: false, code: "unknown" });
    const message = result.ok ? "" : result.message;
    expect(message).toContain("no holder");
    expect(message).toContain("have the operator restart the hc core");
    expect(message).not.toBe("hc refused qa@rig: unavailable");  // the symptom as reported
    expect(client.launchBlockedBecause).toBe(message);           // and `rig health` has it
    expect(await live(client)).toEqual([]);                      // nothing was launched
    expect((await status(client)).version).toBe(from);           // the core still runs the version it started as
    expect(client.launchBlockedBecause).toBe(message);           // other successful calls (the two reads above) do not clear it: only a launch does

    // The fix the message names, run exactly as an operator does with the new file in place.
    assertPrivateHcEnv(s.env, s.root);
    const restart = s.run(["server", "restart"]);
    expect(restart.status, restart.stderr).toBe(0);
    s.refreshOrphanGuard();
    expect((await status(client)).version).toBe(to);
    await expect(host.createSession("qa@rig")).resolves.toEqual({ ok: true });
    expect(client.launchBlockedBecause).toBeNull();              // cleared by the launch that worked
    expect(await live(client)).toEqual([hcTerminalName("qa@rig")]);
  });

  it("a core that already HAS a holder is not affected: the new launch works and the seat launched before stays live", async () => {
    const { client, host, replaceWith } = begin("0.1.15");
    await expect(host.createSession("first@rig")).resolves.toEqual({ ok: true });
    expect((await status(client)).holder).not.toBeNull();
    replaceWith("0.1.16");
    await expect(host.createSession("second@rig")).resolves.toEqual({ ok: true });
    expect((await live(client)).sort()).toEqual([hcTerminalName("first@rig"), hcTerminalName("second@rig")].sort());
    expect(client.launchBlockedBecause).toBeNull();
  });

  it("replacing the file with the SAME build is not the cause: the launch works (a different build is)", async () => {
    const { client, host, replaceWith } = begin("0.1.15");
    replaceWith("0.1.15");
    await expect(host.createSession("qa@rig")).resolves.toEqual({ ok: true });
    expect(client.launchBlockedBecause).toBeNull();
  });

  it("a different hc earlier on PATH is not the cause: only the file the core was started from matters", async () => {
    const { client, host, scratch: s } = begin("0.1.15");
    // Run the 0.1.16 binary as a CLIENT of this core (a read) and launch through the socket: the core still launches with its own file.
    assertPrivateHcEnv(s.env, s.root);
    const ls = spawnSync(release("0.1.16"), ["ls"], { env: s.env, encoding: "utf8", timeout: 30_000 });
    expect(ls.status, ls.stderr).toBe(0);
    await expect(host.createSession("qa@rig")).resolves.toEqual({ ok: true });
    expect((await status(client)).version).toBe("0.1.15");
  });
});
