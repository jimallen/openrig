// hc cutover (Jim, 2026-11-01): the Herdr app updates hc by itself, so a core can be swapped for another release under a running
// daemon. A fake core can only assume what a real one does across that swap, so this runs REAL cores of three real releases, each
// unpacked from its published archive (sha256 checked against releases.herdr.dev/core/<version>/manifest.json) into a folder of the
// operator's own, on a PRIVATE core (startHcScratch: its own HOME, HC_SESSION and XDG paths; never the host's core, the app or
// ~/.local/bin). It is skipped unless OPENRIG_TEST_HC_VERSION_BINS names a folder holding `bin-<version>/herdr-core` for 0.1.14,
// 0.1.15 and 0.1.16. The swap is `server restart` run with the NEW release's binary on the same private env: the core is replaced,
// the terminals' holder stays, which is exactly what an app update does to a running seat host.
//
// Production consequences pinned: a swap between two accepted releases must reconnect with the SAME core id and keep the seat's
// terminal, with no latched refusal (a latch would stop OpenRig managing seats until a daemon restart); a swap to a release
// outside the accepted band must refuse, fail the daemon's calls closed, and show in `rig health`, while the terminal keeps running.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HcClient, HcUnavailableError, type HcTerminal } from "../src/adapters/hc-client.js";
import { HcCoreWatch, pinCallsToCore, startCoreWithCli, type HcNotice } from "../src/adapters/hc-core-watch.js";
import { HcCoreRefusalHealthSource } from "../src/domain/hc-core-refusal-health.js";
import { HcUntestedVersionHealthSource } from "../src/domain/hc-untested-version-health.js";
import { until } from "./hc-private-core.js";
import { assertPrivateHcEnv, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";

const BINS = process.env["OPENRIG_TEST_HC_VERSION_BINS"];
const bin = (version: string): string => join(BINS ?? "", `bin-${version}`, "herdr-core");
const haveAll = BINS !== undefined && ["0.1.14", "0.1.15", "0.1.16"].every((v) => existsSync(bin(v)));
const linux = process.platform === "linux";

describe.skipIf(!haveAll || !linux)("a real core swapped for another release under a running watch", () => {
  let scratch: HcScratch;
  let watch: HcCoreWatch | null;
  let notices: HcNotice[];
  let coreVersion: string | null;
  let lift: (() => void) | null;
  let client: HcClient;

  beforeEach(() => {
    notices = [];
    coreVersion = null;
    watch = null;
    lift = null;
  });
  afterEach(() => {
    lift?.();
    watch?.stop();
    scratch?.cleanup();
  });

  /** The same private env, the NEW release's binary: replaces the core and leaves the holder and the terminals. */
  const swapTo = (version: string): void => {
    assertPrivateHcEnv(scratch.env, scratch.root);
    const out = spawnSync(bin(version), ["server", "restart"], { env: scratch.env, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    expect(out.status, `${version} server restart: ${out.stderr}`).toBe(0);
  };
  const connected = (): HcNotice[] => notices.filter((n) => n.kind === "connected");
  const lastVersion = (): string | undefined => {
    const last = connected().at(-1);
    return last && last.kind === "connected" ? last.version : undefined;
  };

  const begin = async (version: string) => {
    scratch = startHcScratch({ hcBin: bin(version) });
    scratch.run(["--version"]);
    client = new HcClient(scratch.socketPath);
    expect(spawnSync(bin(version), ["--version"], { encoding: "utf8" }).stdout.trim()).toBe(`hc ${version}`);
    const seat = await scratch.client().call<HcTerminal>("terminal.run", { argv: ["sleep", "300"], name: "s-swap", labels: { "openrig.seat": "w@rig" }, no_parent: true, no_notify: true, outlive_parent: true });
    scratch.refreshOrphanGuard();
    watch = new HcCoreWatch({
      socketPath: scratch.socketPath, reconnectDelaysMs: [50, 100, 200], helloTimeoutMs: 2000,
      startCore: async () => { await startCoreWithCli({ env: scratch.env, hcPath: bin(version) })(); },
      onNotice: (n) => {
        notices.push(n);
        if (n.kind === "refused") { client.refuseCore(n.refusal.message); coreVersion = null; }
        if (n.kind === "connected") coreVersion = n.version;
      },
    });
    await watch.start();
    lift = pinCallsToCore(scratch.socketPath, watch);
    return seat;
  };

  it("between two accepted releases (0.1.15 -> 0.1.16 -> 0.1.15): the same core id, the terminal kept, no latch, and the untested notice follows the version", async () => {
    const seat = await begin("0.1.15");
    const untested = new HcUntestedVersionHealthSource(() => coreVersion);
    const refusal = new HcCoreRefusalHealthSource(() => client.refusedBecause);
    expect(watch!.state()).toBe("streaming");
    expect(lastVersion()).toBe("0.1.15");
    expect(untested.coverage()).toHaveLength(1);              // 0.1.15 is accepted, not tested
    const coreId = watch!.pinnedCoreId();
    expect(coreId).toBeTruthy();

    swapTo("0.1.16");
    await until(() => lastVersion(), (v) => v === "0.1.16", "the watch to reconnect to the 0.1.16 core");
    expect(watch!.state()).toBe("streaming");
    expect(watch!.pinnedCoreId()).toBe(coreId);               // the same core, not a swapped one
    expect(watch!.view().terminals.get(seat.address)).toMatchObject({ state: "live", pid: seat.pid });
    expect(client.refusedBecause).toBeNull();
    expect(refusal.coverage()).toEqual([]);
    expect(untested.coverage()).toEqual([]);                  // 0.1.16 is the tested version
    await expect(client.call("terminal.get", { terminal: seat.address })).resolves.toMatchObject({ state: "live" });  // calls pass the same rule

    swapTo("0.1.15");
    await until(() => connected().length, (n) => n >= 3, "the watch to reconnect to the 0.1.15 core");
    expect(lastVersion()).toBe("0.1.15");
    expect(watch!.state()).toBe("streaming");
    expect(watch!.pinnedCoreId()).toBe(coreId);
    expect(watch!.view().terminals.get(seat.address)).toMatchObject({ state: "live", pid: seat.pid });
    expect(client.refusedBecause).toBeNull();
    expect(untested.coverage()).toHaveLength(1);
    expect(notices.filter((n) => n.kind === "refused")).toEqual([]);
  }, 90_000);

  it("to a release outside the accepted band (0.1.16 -> 0.1.14): refused, named in health, calls fail closed, the terminal keeps running", async () => {
    const seat = await begin("0.1.16");
    const untested = new HcUntestedVersionHealthSource(() => coreVersion);
    const refusal = new HcCoreRefusalHealthSource(() => client.refusedBecause);
    expect(watch!.state()).toBe("streaming");
    expect(refusal.coverage()).toEqual([]);

    swapTo("0.1.14");
    await until(() => watch!.state(), (s) => s === "refused", "the watch to refuse the 0.1.14 core");
    expect(notices.filter((n) => n.kind === "refused")).toHaveLength(1);
    expect(notices.find((n) => n.kind === "refused")).toMatchObject({ refusal: { kind: "unsupported_version" } });
    const rows = refusal.coverage();
    expect(rows).toHaveLength(1);
    expect(rows[0] && "reason" in rows[0] ? rows[0].reason : "").toContain("0.1.14");
    expect(untested.coverage()).toEqual([]);                  // the refusal speaks; no untested row beside it
    await expect(client.call("terminal.list")).rejects.toBeInstanceOf(HcUnavailableError);
    // The terminal is not touched: read it through a client that skips the daemon's pin, as an operator's own hc would.
    lift?.();
    lift = null;
    await expect(new HcClient(scratch.socketPath).call("terminal.get", { terminal: seat.address })).resolves.toMatchObject({ state: "live", pid: seat.pid });
  }, 90_000);
});
