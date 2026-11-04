// OF-208 — iOS simulator lifecycle. Every simctl call goes to a fake (SimctlExec injected, the way the daemon injects its
// other external tools); no test or kit runs the real simctl.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import {
  SimulatorLifecycle, nameIsForSeat, seatToken, parseSimctlDevices,
  BYTES_PER_GB, SIMULATOR_SIZE_CAP_DEFAULT_GB, realSimctlAllowed, enableRealSimctlIfAllowed, buildSimulatorLifecycle, type SimctlExec,
} from "../src/domain/simulator-lifecycle.js";

const GB = BYTES_PER_GB;

interface FakeDevice { udid: string; name: string; state: string; isAvailable?: boolean; dataPathSize?: number | null }

/** A fake `xcrun simctl`: `list devices -j` renders `devices`; `erase <udid>` is recorded and applied. */
function fakeSimctl(devices: FakeDevice[]) {
  const calls: string[][] = [];
  const state = { devices, failList: null as Error | null, failErase: null as Error | null, onList: null as (() => void) | null, listDelay: 0 };
  const exec: SimctlExec = async (args) => {
    calls.push(args);
    if (args[0] === "list") {
      if (state.failList) throw state.failList;
      if (state.listDelay) await new Promise((r) => setTimeout(r, state.listDelay));
      const body = {
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-27-1": state.devices.map((d) => ({
            udid: d.udid, name: d.name, state: d.state, isAvailable: d.isAvailable ?? true,
            ...(d.dataPathSize === null ? {} : { dataPathSize: d.dataPathSize ?? 0 }),
          })),
        },
      };
      const out = JSON.stringify(body);
      state.onList?.();
      return out;
    }
    if (args[0] === "erase") {
      if (state.failErase) throw state.failErase;
      const d = state.devices.find((x) => x.udid === args[1]);
      if (d) d.dataPathSize = 18_337_792;
      return "";
    }
    throw new Error(`fake simctl: unexpected ${args.join(" ")}`);
  };
  const erased = () => calls.filter((c) => c[0] === "erase").map((c) => c[1]);
  return { exec, calls, state, erased };
}

class ThrowingEventBus extends EventBus {
  override emit(): never { throw new Error("db locked"); }
}

const U = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

/** A directory holding an `xcrun` that records every call to `log` and answers `list` with no devices: the real simctl is never reachable. */
function stubXcrun(): { dir: string; log: string; calls: () => string[]; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "of208-xcrun-"));
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(path.join(dir, "xcrun"), `#!/bin/sh\necho "$@" >> '${log}'\necho '{"devices":{}}'\n`, { mode: 0o755 });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  return { dir, log, calls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe("OF-208 real simctl is fail-closed", () => {
  const home = "/Users/someone";
  const allowed = (over: Partial<Parameters<typeof realSimctlAllowed>[0]> = {}) =>
    realSimctlAllowed({ env: {}, userHome: home, openrigHome: `${home}/.openrig`, ...over });

  it("is allowed only for the account's own default state directory outside a test runner", () => {
    expect(allowed()).toBe(true);
    expect(allowed({ openrigHome: "/var/folders/xx/scratch/openrig-home" })).toBe(false); // every scenario / hermetic daemon
    expect(allowed({ openrigHome: `${home}/.openrig-other` })).toBe(false);
    expect(allowed({ openrigHome: `${home}/.openrig/../.openrig` })).toBe(true); // resolved, not string-compared
    expect(allowed({ env: { VITEST: "true" } })).toBe(false);
    expect(allowed({ env: { NODE_ENV: "test" } })).toBe(false);
    expect(allowed({ userHome: "" })).toBe(false);
    expect(allowed({ openrigHome: "" })).toBe(false);
  });

  it("the production entrypoint's request switches it on only with the default home and no test runner", () => {
    const on = vi.fn();
    const svc = { enableRealSimctl: on };
    const base = { requested: true as boolean | undefined, env: {} as Record<string, string | undefined>, userHome: home, openrigHome: `${home}/.openrig` };
    expect(enableRealSimctlIfAllowed(svc, base)).toBe(true);
    expect(on).toHaveBeenCalledTimes(1);
    for (const refused of [
      { ...base, requested: undefined }, // an imported startServer
      { ...base, requested: false },
      { ...base, openrigHome: "/tmp/scenario-home" }, // a scenario / hermetic daemon
      { ...base, env: { VITEST: "true" } },
      { ...base, env: { NODE_ENV: "test" } },
    ]) {
      expect(enableRealSimctlIfAllowed(svc, refused)).toBe(false);
    }
    expect(enableRealSimctlIfAllowed(undefined, base)).toBe(false);
    expect(on).toHaveBeenCalledTimes(1);
  });

  it("a service built without an exec runs no simctl, for a sweep or a removal, and starts no timer", async () => {
    const db = createFullTestDb();
    const stub = stubXcrun();
    const savedPath = process.env["PATH"];
    process.env["PATH"] = `${stub.dir}:/usr/bin:/bin`;
    try {
      const repo = new RigRepository(db);
      const rig = repo.createRig("eztrack");
      const node = repo.addNode(rig.id, "verify.qa", { runtime: "terminal" });
      const sim = new SimulatorLifecycle({ db, eventBus: new EventBus(db), capGb: () => 1, platform: "darwin", log: () => {} });
      expect(sim.enabled).toBe(false);
      expect(await sim.sweepOverCap()).toEqual({ status: "disabled", outcomes: [] });
      const removed = sim.seatsForRemoval(rig.id, node.id);
      repo.deleteNode(node.id);
      expect(await sim.eraseForRemovedSeats(removed, "seat_removed")).toEqual({ status: "disabled", outcomes: [] });
      expect(sim.startSweepTimer(10)).toBeNull();
      expect(stub.calls()).toEqual([]);
    } finally {
      process.env["PATH"] = savedPath;
      stub.cleanup();
      db.close();
    }
  });

  it("enableRealSimctl is the one switch: afterwards the service reaches xcrun (the stub, here)", async () => {
    const db = createFullTestDb();
    const stub = stubXcrun();
    const savedPath = process.env["PATH"];
    process.env["PATH"] = `${stub.dir}:/usr/bin:/bin`;
    try {
      const sim = new SimulatorLifecycle({ db, eventBus: new EventBus(db), capGb: () => 1, platform: "darwin", log: () => {} });
      sim.enableRealSimctl();
      expect(sim.enabled).toBe(true);
      expect((await sim.sweepOverCap()).status).toBe("ok");
      expect(stub.calls()).toEqual(["simctl list devices -j"]);
    } finally {
      process.env["PATH"] = savedPath;
      stub.cleanup();
      db.close();
    }
  });
});

describe("OF-208 simulator naming", () => {
  it("a seat's token is the last dot-segment of its logical id, lower-cased", () => {
    expect(seatToken("verify.QA")).toBe("qa");
    expect(seatToken("solo")).toBe("solo");
  });

  it("a device is named for a seat only by token + dash, case-insensitively", () => {
    expect(nameIsForSeat("qa-duo-271", "verify.qa")).toBe(true);
    expect(nameIsForSeat("QA-duo-271", "verify.qa")).toBe(true);
    expect(nameIsForSeat("qa", "verify.qa")).toBe(false); // no dash
    expect(nameIsForSeat("qa2-duo-271", "verify.qa")).toBe(false); // a different seat's token
    expect(nameIsForSeat("xqa-duo", "verify.qa")).toBe(false); // not a prefix
    expect(nameIsForSeat("-duo", "verify.")).toBe(false); // empty token matches nothing
  });

  it("parses dataPathSize as bytes and treats a missing or non-numeric size as unknown", () => {
    const out = parseSimctlDevices(JSON.stringify({ devices: { r: [
      { udid: "a", name: "n", state: "Shutdown", isAvailable: true, dataPathSize: 5 },
      { udid: "b", name: "n", state: "Shutdown", isAvailable: true },
      { udid: "c", name: "n", state: "Shutdown", isAvailable: true, dataPathSize: "7" },
    ] } }));
    expect(out.map((d) => d.sizeBytes)).toEqual([5, null, null]);
  });
});

describe("OF-208 SimulatorLifecycle", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let eventBus: EventBus;
  let log: string[];

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    eventBus = new EventBus(db);
    log = [];
  });
  afterEach(() => db.close());

  const make = (fake: ReturnType<typeof fakeSimctl>, capGb?: () => number, platform = "darwin", claimDirs?: () => string[]) =>
    new SimulatorLifecycle({ db, eventBus, simctl: fake.exec, capGb, claimDirs, platform, log: (l) => log.push(l) });

  const events = () => (db.prepare("SELECT rig_id, node_id, payload FROM events WHERE type = 'simulator.erased' ORDER BY seq").all() as Array<{ rig_id: string; node_id: string; payload: string }>)
    .map((r) => ({ ...r, p: JSON.parse(r.payload) as Record<string, unknown> }));

  /** One rig "eztrack" with the seats the existing devices are named for, minus whatever the test removes. */
  function seedRig(name = "eztrack", logicalIds = ["verify.qa", "build.impl", "build.ux"]) {
    const rig = rigRepo.createRig(name);
    const nodes = Object.fromEntries(logicalIds.map((id) => [id, rigRepo.addNode(rig.id, id, { runtime: "terminal" })]));
    return { rig, nodes };
  }

  describe("trigger (a): removal", () => {
    it("erases only the removed seat's attributed, shut-down devices", async () => {
      const { rig, nodes } = seedRig();
      const fake = fakeSimctl([
        { udid: U(1), name: "qa-duo-271", state: "Shutdown", dataPathSize: 8 * GB },
        { udid: U(2), name: "impl-xedd-duo-271", state: "Shutdown", dataPathSize: 9 * GB }, // another live seat's
        { udid: U(3), name: "lw7t3-meal-timing-abc", state: "Shutdown", dataPathSize: 9 * GB }, // nobody's
      ]);
      const sim = make(fake);
      const removed = sim.seatsForRemoval(rig.id, nodes["verify.qa"]!.id);
      expect(removed).toEqual([{ rigId: rig.id, nodeId: nodes["verify.qa"]!.id, logicalId: "verify.qa" }]); // only the one seat
      rigRepo.deleteNode(nodes["verify.qa"]!.id);
      const res = await sim.eraseForRemovedSeats(removed, "seat_removed");
      expect(res.status).toBe("ok");
      expect(fake.erased()).toEqual([U(1)]);
    });

    it("skips a booted device of the removed seat and says so", async () => {
      const { rig, nodes } = seedRig();
      const fake = fakeSimctl([
        { udid: U(1), name: "qa-duo-271", state: "Booted", dataPathSize: 8 * GB },
        { udid: U(2), name: "qa-duo-272", state: "Shutting Down", dataPathSize: 8 * GB },
        { udid: U(3), name: "qa-duo-273", state: "Shutdown", dataPathSize: 8 * GB },
      ]);
      const sim = make(fake);
      const removed = sim.seatsForRemoval(rig.id, nodes["verify.qa"]!.id);
      rigRepo.deleteNode(nodes["verify.qa"]!.id);
      const res = await sim.eraseForRemovedSeats(removed, "seat_removed");
      expect(fake.erased()).toEqual([U(3)]);
      expect(res.outcomes.filter((o) => o.action === "skipped").map((o) => [o.udid, o.reason])).toEqual([
        [U(1), "not_shut_down:Booted"], [U(2), "not_shut_down:Shutting Down"],
      ]);
      expect(log.some((l) => l.includes(U(1)) && l.includes("Booted"))).toBe(true);
    });

    it("never touches a device no seat is named for, nor an unavailable one", async () => {
      const { rig, nodes } = seedRig();
      const fake = fakeSimctl([
        { udid: U(1), name: "somebody-elses-sim", state: "Shutdown", dataPathSize: 30 * GB },
        { udid: U(2), name: "qa", state: "Shutdown", dataPathSize: 30 * GB },
        { udid: U(3), name: "qa-gone-runtime", state: "Shutdown", isAvailable: false, dataPathSize: 30 * GB },
      ]);
      const sim = make(fake);
      const removed = sim.seatsForRemoval(rig.id, nodes["verify.qa"]!.id);
      rigRepo.deleteNode(nodes["verify.qa"]!.id);
      await sim.eraseForRemovedSeats(removed, "seat_removed");
      expect(fake.erased()).toEqual([]);
    });

    it("leaves a device two seats could own: the same member id in another rig", async () => {
      const a = seedRig("eztrack", ["verify.qa"]);
      seedRig("other-rig", ["review.qa"]);
      const fake = fakeSimctl([{ udid: U(1), name: "qa-duo-271", state: "Shutdown", dataPathSize: 8 * GB }]);
      const sim = make(fake);
      const removed = sim.seatsForRemoval(a.rig.id, a.nodes["verify.qa"]!.id);
      rigRepo.deleteNode(a.nodes["verify.qa"]!.id);
      const res = await sim.eraseForRemovedSeats(removed, "seat_removed");
      expect(fake.erased()).toEqual([]);
      expect(res.outcomes[0]).toMatchObject({ action: "skipped", reason: "ambiguous" });
    });

    it("a rig removal erases every removed seat's devices and records rig_deleted", async () => {
      const { rig } = seedRig();
      const fake = fakeSimctl([
        { udid: U(1), name: "qa-duo-271", state: "Shutdown", dataPathSize: 8 * GB },
        { udid: U(2), name: "impl-xedd-duo-271", state: "Shutdown", dataPathSize: 9 * GB },
        { udid: U(3), name: "ux-duo-271", state: "Booted", dataPathSize: 12 * GB },
      ]);
      const sim = make(fake);
      const removed = sim.seatsForRemoval(rig.id);
      expect(removed).toHaveLength(3);
      rigRepo.deleteRig(rig.id);
      await sim.eraseForRemovedSeats(removed, "rig_deleted");
      expect(fake.erased().sort()).toEqual([U(1), U(2)]);
      expect(events().map((e) => e.p["reason"])).toEqual(["rig_deleted", "rig_deleted"]);
    });

    it("re-reads the device right before the erase: a device booted in between is left alone", async () => {
      const { rig, nodes } = seedRig();
      const fake = fakeSimctl([{ udid: U(1), name: "qa-duo-271", state: "Shutdown", dataPathSize: 8 * GB }]);
      let lists = 0;
      fake.state.onList = () => { if (++lists === 1) fake.state.devices[0]!.state = "Booted"; };
      // The first list is rendered before onList runs, so it reads Shutdown; every later list reads Booted.
      const sim = make(fake);
      const removed = sim.seatsForRemoval(rig.id, nodes["verify.qa"]!.id);
      rigRepo.deleteNode(nodes["verify.qa"]!.id);
      const res = await sim.eraseForRemovedSeats(removed, "seat_removed");
      expect(fake.erased()).toEqual([]);
      expect(res.outcomes[0]).toMatchObject({ action: "skipped", reason: "not_shut_down:Booted" });
      expect(events()).toEqual([]);
    });
  });

  describe("trigger (b): size cap", () => {
    it("erases a shut-down attributed device only above the cap (strictly)", async () => {
      seedRig();
      const fake = fakeSimctl([
        { udid: U(1), name: "qa-duo-271", state: "Shutdown", dataPathSize: 20 * GB + 1 },
        { udid: U(2), name: "impl-duo-1", state: "Shutdown", dataPathSize: 20 * GB },
        { udid: U(3), name: "ux-duo-1", state: "Shutdown", dataPathSize: 19 * GB },
      ]);
      const res = await make(fake, () => 20).sweepOverCap();
      expect(res.status).toBe("ok");
      expect(fake.erased()).toEqual([U(1)]);
      expect(res.outcomes.filter((o) => o.reason === "under_cap").map((o) => o.udid)).toEqual([U(2), U(3)]);
    });

    it("never erases a booted device, however big", async () => {
      seedRig();
      const fake = fakeSimctl([{ udid: U(1), name: "impl-xedd-duo-271", state: "Booted", dataPathSize: 18.8 * GB * 3 }]);
      await make(fake, () => 20).sweepOverCap();
      expect(fake.erased()).toEqual([]);
    });

    it("never erases an unattributed or ambiguous device, however big", async () => {
      seedRig("eztrack", ["verify.qa"]);
      seedRig("other-rig", ["review.qa"]);
      const fake = fakeSimctl([
        { udid: U(1), name: "lw7t3-meal-timing-abc", state: "Shutdown", dataPathSize: 60 * GB },
        { udid: U(2), name: "qa-duo-271", state: "Shutdown", dataPathSize: 60 * GB },
      ]);
      const res = await make(fake, () => 20).sweepOverCap();
      expect(fake.erased()).toEqual([]);
      expect(res.outcomes.map((o) => o.reason)).toEqual(["unattributed", "ambiguous"]);
    });

    it("leaves a device whose size simctl did not give", async () => {
      seedRig();
      const fake = fakeSimctl([{ udid: U(1), name: "qa-duo-271", state: "Shutdown", dataPathSize: null }]);
      const res = await make(fake, () => 20).sweepOverCap();
      expect(fake.erased()).toEqual([]);
      expect(res.outcomes[0]).toMatchObject({ action: "skipped", reason: "size_unknown" });
    });

    it("reads the cap fresh each sweep and 0 turns the sweep off without calling simctl", async () => {
      seedRig();
      const fake = fakeSimctl([{ udid: U(1), name: "qa-duo-271", state: "Shutdown", dataPathSize: 8 * GB }]);
      let cap = 0;
      const sim = make(fake, () => cap);
      expect((await sim.sweepOverCap()).status).toBe("disabled");
      expect(fake.calls).toEqual([]);
      cap = 5;
      await sim.sweepOverCap();
      expect(fake.erased()).toEqual([U(1)]);
    });

    it("a throwing cap read (corrupt config.json) makes the sweep unavailable and logged, not an exception", async () => {
      seedRig();
      const fake = fakeSimctl([{ udid: U(1), name: "qa-duo-271", state: "Shutdown", dataPathSize: 30 * GB }]);
      const sim = make(fake, () => { throw new Error("Unexpected token } in JSON at position 12"); });
      await expect(Promise.resolve().then(() => sim.sweepOverCap())).resolves.toEqual({ status: "unavailable", outcomes: [] });
      expect(log.some((l) => l.includes("cap could not be read") && l.includes("Unexpected token"))).toBe(true);
      expect(fake.calls).toEqual([]);
    });

    it("the timer callback survives a throwing cap read: no exception escapes a tick", async () => {
      seedRig();
      vi.useFakeTimers();
      try {
        const sim = make(fakeSimctl([]), () => { throw new Error("config unreadable"); });
        const timer = sim.startSweepTimer(1000)!;
        await vi.advanceTimersByTimeAsync(2500); // boot tick + two interval ticks; an escaped throw fails the test
        clearInterval(timer);
        expect(log.filter((l) => l.includes("cap could not be read")).length).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("the daemon setting defaults to 20 GB and an override reaches the sweep", async () => {
      seedRig();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "of208-cfg-"));
      const cfg = path.join(dir, "config.json");
      const savedEnv = process.env["OPENRIG_SIMULATORS_SIZE_CAP_GB"];
      delete process.env["OPENRIG_SIMULATORS_SIZE_CAP_GB"];
      try {
        const store = new SettingsStore(cfg);
        expect(SIMULATOR_SIZE_CAP_DEFAULT_GB).toBe(20);
        expect(store.resolveOne("simulators.size_cap_gb")).toMatchObject({ value: 20, source: "default" });

        const fake = fakeSimctl([{ udid: U(1), name: "qa-duo-271", state: "Shutdown", dataPathSize: 8 * GB }]);
        const sim = make(fake, () => Number(store.resolveOne("simulators.size_cap_gb").value));
        await sim.sweepOverCap();
        expect(fake.erased()).toEqual([]); // 8 GB is under the default 20

        store.set("simulators.size_cap_gb", "5");
        expect(store.resolveOne("simulators.size_cap_gb")).toMatchObject({ value: 5, source: "file" });
        await sim.sweepOverCap();
        expect(fake.erased()).toEqual([U(1)]); // 8 GB is over 5

        expect(() => store.set("simulators.size_cap_gb", "-1")).toThrow(/integer >= 0/);
        expect(() => store.set("simulators.size_cap_gb", "ten")).toThrow();
        process.env["OPENRIG_SIMULATORS_SIZE_CAP_GB"] = "7";
        expect(store.resolveOne("simulators.size_cap_gb")).toMatchObject({ value: 7, source: "env" });
      } finally {
        if (savedEnv === undefined) delete process.env["OPENRIG_SIMULATORS_SIZE_CAP_GB"]; else process.env["OPENRIG_SIMULATORS_SIZE_CAP_GB"] = savedEnv;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("the timer is not started off darwin and ticks on darwin (boot sweep, then each interval)", async () => {
      seedRig();
      const fake = fakeSimctl([]);
      expect(make(fake, () => 20, "linux").startSweepTimer(1000)).toBeNull();
      expect(fake.calls).toEqual([]);

      vi.useFakeTimers();
      try {
        const timer = make(fake, () => 20, "darwin").startSweepTimer(1000)!;
        expect(timer).not.toBeNull();
        await vi.advanceTimersByTimeAsync(0);
        const boot = fake.calls.filter((c) => c[0] === "list").length;
        expect(boot).toBe(1);
        await vi.advanceTimersByTimeAsync(2500);
        expect(fake.calls.filter((c) => c[0] === "list").length).toBe(3);
        clearInterval(timer);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("claims (OF-222): a device a test guard has claimed is never erased", () => {
    let claims: string; // a scratch stand-in for a guard's claim directory (never eztrack's)
    let queue: string;
    beforeEach(() => {
      claims = fs.mkdtempSync(path.join(os.tmpdir(), "of222-claims-"));
      queue = fs.mkdtempSync(path.join(os.tmpdir(), "of222-queue-"));
    });
    afterEach(() => {
      for (const d of [claims, queue]) { fs.chmodSync(d, 0o755); fs.rmSync(d, { recursive: true, force: true }); }
    });
    const big = (n: number, name: string): FakeDevice => ({ udid: UD(n), name, state: "Shutdown", dataPathSize: 30 * GB });
    // A real-shaped UDID per device: the claim matcher is UDID-shaped.
    const UD = (n: number) => `0000000${n}-ABCD-4000-8000-00000000AB0${n}`.toUpperCase(); // hex letters, so a lower-case claim name differs from it
    const dirs = () => [claims, queue];

    it("the sweep skips a device whose UDID is a directory name in a claim dir, and erases its unclaimed sibling", async () => {
      seedRig();
      fs.mkdirSync(path.join(claims, UD(1)));
      fs.writeFileSync(path.join(claims, UD(1), "owner"), "ui-run-sim v1\nslot=1\n");
      const fake = fakeSimctl([big(1, "qa-duo-271"), big(2, "impl-duo-1")]);
      const res = await make(fake, () => 20, "darwin", dirs).sweepOverCap();
      expect(fake.erased()).toEqual([UD(2)]);
      expect(res.outcomes.find((o) => o.udid === UD(1))).toMatchObject({ action: "skipped", reason: "claimed" });
    });

    it("a claim name in lower case still claims; a RELEASED claim (<UDID>.released.<pid>) does not", async () => {
      seedRig();
      fs.mkdirSync(path.join(claims, UD(1).toLowerCase()));
      fs.mkdirSync(path.join(claims, `${UD(2)}.released.12186`));
      const fake = fakeSimctl([big(1, "qa-duo-271"), big(2, "impl-duo-1")]);
      await make(fake, () => 20, "darwin", dirs).sweepOverCap();
      expect(fake.erased()).toEqual([UD(2)]);
    });

    it("a queued run's one-line file claims its UDID; an empty file and an oversized file claim nothing", async () => {
      seedRig();
      fs.writeFileSync(path.join(queue, "15821.sim"), `${UD(1)}\n`);
      fs.writeFileSync(path.join(queue, "15821.v2"), "");
      fs.writeFileSync(path.join(queue, "999.log"), `${UD(2)} ${"x".repeat(300)}`);
      const fake = fakeSimctl([big(1, "qa-duo-271"), big(2, "impl-duo-1"), big(3, "ux-duo-1")]);
      await make(fake, () => 20, "darwin", dirs).sweepOverCap();
      expect(fake.erased()).toEqual([UD(2), UD(3)]);
    });

    it("with no claim dirs configured, or a dir that does not exist, nothing is claimed", async () => {
      seedRig();
      const fake = fakeSimctl([big(1, "qa-duo-271")]);
      await make(fake, () => 20, "darwin", () => [path.join(claims, "no-such-dir")]).sweepOverCap();
      expect(fake.erased()).toEqual([UD(1)]);
      const fake2 = fakeSimctl([big(1, "qa-duo-271")]);
      await make(fake2, () => 20).sweepOverCap();
      expect(fake2.erased()).toEqual([UD(1)]);
    });

    it("a claim dir that cannot be listed makes the sweep erase nothing (fail closed)", async () => {
      seedRig();
      fs.chmodSync(claims, 0o000);
      const fake = fakeSimctl([big(1, "qa-duo-271")]);
      const res = await make(fake, () => 20, "darwin", dirs).sweepOverCap();
      expect(fake.erased()).toEqual([]);
      expect(res.outcomes[0]).toMatchObject({ action: "skipped", reason: "claims_unreadable" });
    });

    it("a claim dir with more than 2000 entries, or a claim-dir setting that throws, also fails closed", async () => {
      seedRig();
      for (let i = 0; i < 2001; i++) fs.writeFileSync(path.join(queue, `f${i}`), "");
      const fake = fakeSimctl([big(1, "qa-duo-271")]);
      const res = await make(fake, () => 20, "darwin", dirs).sweepOverCap();
      expect(fake.erased()).toEqual([]);
      expect(res.outcomes[0]).toMatchObject({ reason: "claims_unreadable" });
      const fake2 = fakeSimctl([big(1, "qa-duo-271")]);
      const res2 = await make(fake2, () => 20, "darwin", () => { throw new Error("config unreadable"); }).sweepOverCap();
      expect(fake2.erased()).toEqual([]);
      expect(res2.outcomes[0]).toMatchObject({ reason: "claims_unreadable" });
    });

    it("a claim file that cannot be read fails closed: nothing is erased this run, and the reason is logged", async () => {
      seedRig();
      const f = path.join(queue, "9.sim");
      fs.writeFileSync(f, `${UD(1)}\n`);
      fs.chmodSync(f, 0o000);
      const fake = fakeSimctl([big(1, "qa-duo-271"), big(2, "impl-duo-1")]);
      const res = await make(fake, () => 20, "darwin", dirs).sweepOverCap();
      expect(fake.erased()).toEqual([]);
      expect(res.outcomes.every((o) => o.reason === "claims_unreadable")).toBe(true);
      expect(log.some((l) => l.includes("claims unreadable") && l.includes(f))).toBe(true);
    });

    it("a claim file that vanishes between the listing and the read (a claim being released) claims nothing and does not stop the sweep", async () => {
      seedRig();
      fs.writeFileSync(path.join(queue, "1.sim"), UD(1));
      const fake = fakeSimctl([big(1, "qa-duo-271")]);
      // A claim dir listing that names an entry which no longer exists.
      const sim = make(fake, () => 20, "darwin", () => [queue]);
      fs.rmSync(path.join(queue, "1.sim"));
      fs.symlinkSync(path.join(queue, "gone-target"), path.join(queue, "dangling.sim")); // statSync -> ENOENT, like a vanished entry
      await sim.sweepOverCap();
      expect(fake.erased()).toEqual([UD(1)]);
    });

    it("a lower-case UDID inside a claim file claims it", async () => {
      seedRig();
      fs.writeFileSync(path.join(queue, "5.sim"), `${UD(1).toLowerCase()}\n`);
      const fake = fakeSimctl([big(1, "qa-duo-271"), big(2, "impl-duo-1")]);
      await make(fake, () => 20, "darwin", dirs).sweepOverCap();
      expect(fake.erased()).toEqual([UD(2)]);
    });

    it("a configured claim dir that does not exist claims nothing and is logged once per run, naming the path", async () => {
      seedRig();
      const typo = path.join(claims, "lock.queuee");
      const fake = fakeSimctl([big(1, "qa-duo-271"), big(2, "impl-duo-1"), big(3, "ux-duo-1")]);
      const sim = make(fake, () => 20, "darwin", () => [typo, queue]);
      await sim.sweepOverCap();
      expect(fake.erased()).toEqual([UD(1), UD(2), UD(3)]); // missing claims nothing
      // three devices means the claims were read four times (the start and a re-read each); the line appears once
      expect(log.filter((l) => l.includes("claim dir does not exist") && l.includes(typo))).toHaveLength(1);
      await sim.sweepOverCap();
      expect(log.filter((l) => l.includes("claim dir does not exist"))).toHaveLength(2); // once per run, not once per process
    });

    it("an existing claim dir logs no missing-dir line", async () => {
      seedRig();
      const fake = fakeSimctl([big(1, "qa-duo-271")]);
      await make(fake, () => 20, "darwin", dirs).sweepOverCap();
      expect(log.filter((l) => l.includes("does not exist"))).toEqual([]);
    });

    it("the service built the way startup builds it reads claim_dirs from the settings store (and the cap)", () => {
      seedRig();
      fs.mkdirSync(path.join(claims, UD(4)));
      fs.writeFileSync(path.join(queue, "2.sim"), UD(5));
      const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "of222-startup-cfg-"));
      const saved = process.env["OPENRIG_SIMULATORS_CLAIM_DIRS"];
      delete process.env["OPENRIG_SIMULATORS_CLAIM_DIRS"];
      try {
        const store = new SettingsStore(path.join(cfgDir, "config.json"));
        store.set("simulators.claim_dirs", ` ${claims} , ${queue},`);
        const sim = buildSimulatorLifecycle({ db, eventBus, settings: () => store });
        expect(sim.claimedUdids()).toEqual([UD(4), UD(5)].sort());
        // read fresh on every use: a claim added later is seen, and an emptied setting claims nothing
        fs.mkdirSync(path.join(claims, UD(6)));
        expect(sim.claimedUdids()).toContain(UD(6));
        store.set("simulators.claim_dirs", "");
        expect(sim.claimedUdids()).toEqual([]);
        // the cap comes through the same store
        store.set("simulators.size_cap_gb", "0");
        return sim.sweepOverCap().then((r) => expect(r.status).toBe("disabled"));
      } finally {
        if (saved === undefined) delete process.env["OPENRIG_SIMULATORS_CLAIM_DIRS"]; else process.env["OPENRIG_SIMULATORS_CLAIM_DIRS"] = saved;
        fs.rmSync(cfgDir, { recursive: true, force: true });
      }
    });

    it("startup.ts builds the service through buildSimulatorLifecycle with the settings store, and nowhere constructs it bare", () => {
      const startup = fs.readFileSync(path.resolve(import.meta.dirname, "../src/startup.ts"), "utf8");
      expect(startup).toContain("buildSimulatorLifecycle({ db, eventBus, settings: () => new ContextPackSettingsStore() })");
      expect(startup).not.toMatch(/new SimulatorLifecycle\(/);
      expect(startup).toMatch(/simulatorLifecycle,\n\s+rigExpansionService,/); // handed to the app deps
    });

    it("a claim granted between the first read and the erase protects the device (claims are re-read with the state)", async () => {
      seedRig();
      const fake = fakeSimctl([big(1, "qa-duo-271")]);
      let lists = 0;
      fake.state.onList = () => { if (++lists === 2) fs.mkdirSync(path.join(claims, UD(1))); }; // the claim appears during the re-read, after the first claims read
      const res = await make(fake, () => 20, "darwin", dirs).sweepOverCap();
      expect(fake.erased()).toEqual([]);
      expect(res.outcomes[0]).toMatchObject({ action: "skipped", reason: "claimed" });
    });

    it("removal also leaves a claimed device of the removed seat alone", async () => {
      const { rig, nodes } = seedRig();
      fs.writeFileSync(path.join(queue, "1.sim"), UD(1));
      const fake = fakeSimctl([big(1, "qa-duo-271"), big(2, "qa-duo-272")]);
      const sim = make(fake, undefined, "darwin", dirs);
      const removed = sim.seatsForRemoval(rig.id, nodes["verify.qa"]!.id);
      rigRepo.deleteNode(nodes["verify.qa"]!.id);
      const res = await sim.eraseForRemovedSeats(removed, "seat_removed");
      expect(fake.erased()).toEqual([UD(2)]);
      expect(res.outcomes.find((o) => o.udid === UD(1))).toMatchObject({ action: "skipped", reason: "claimed" });
    });

    it("planOverCap shows claimed, and the sweep leaves the claim dirs byte-for-byte as they were", async () => {
      const a = seedRig();
      fs.mkdirSync(path.join(claims, UD(1)));
      fs.writeFileSync(path.join(claims, UD(1), "owner"), "ui-run-sim v1\n");
      fs.writeFileSync(path.join(queue, "7.sim"), UD(2));
      const snap = () => JSON.stringify([claims, queue].map((d) => fs.readdirSync(d, { recursive: true, withFileTypes: false }).sort().map((n) => {
        const st = fs.statSync(path.join(d, String(n)));
        return [n, st.mtimeMs, st.isFile() ? fs.readFileSync(path.join(d, String(n)), "utf8") : "dir"];
      })));
      const before = snap();
      const fake = fakeSimctl([big(1, "qa-duo-271"), big(2, "impl-duo-1"), big(3, "ux-duo-1")]);
      const sim = make(fake, () => 20, "darwin", dirs);
      const plan = await sim.planOverCap();
      expect(plan.rows.map((r) => [r.device.udid, r.verdict, r.seat])).toEqual([
        [UD(1), "claimed", "verify.qa"], [UD(2), "claimed", "build.impl"], [UD(3), "erase", "build.ux"],
      ]);
      await sim.sweepOverCap();
      expect(snap()).toBe(before);
      void a;
    });

    it("the claim_dirs setting defaults to empty, takes absolute paths, and refuses a relative one", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "of222-cfg-"));
      const saved = process.env["OPENRIG_SIMULATORS_CLAIM_DIRS"];
      delete process.env["OPENRIG_SIMULATORS_CLAIM_DIRS"];
      try {
        const store = new SettingsStore(path.join(dir, "config.json"));
        expect(store.resolveOne("simulators.claim_dirs")).toMatchObject({ value: "", source: "default" });
        store.set("simulators.claim_dirs", "/a/lock.sim, /a/lock.queue");
        expect(store.resolveOne("simulators.claim_dirs")).toMatchObject({ value: "/a/lock.sim, /a/lock.queue", source: "file" });
        expect(() => store.set("simulators.claim_dirs", "/a/ok,relative/dir")).toThrow(/absolute directory path/);
        process.env["OPENRIG_SIMULATORS_CLAIM_DIRS"] = "/env/dir";
        expect(store.resolveOne("simulators.claim_dirs")).toMatchObject({ value: "/env/dir", source: "env" });
      } finally {
        if (saved === undefined) delete process.env["OPENRIG_SIMULATORS_CLAIM_DIRS"]; else process.env["OPENRIG_SIMULATORS_CLAIM_DIRS"] = saved;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("which seats take part", () => {
    it("a kernel seat's generic token never claims a hand-made device, and does not make a project seat's device ambiguous", async () => {
      seedRig("kernel", ["ops.worker", "ops.steward"]);
      const proj = seedRig("eztrack", ["build.worker"]);
      const fake = fakeSimctl([
        { udid: U(1), name: "steward-test", state: "Shutdown", dataPathSize: 60 * GB }, // hand-made; only the kernel has a `steward`
        { udid: U(2), name: "worker-test", state: "Shutdown", dataPathSize: 60 * GB }, // hand-made; a project seat is `worker` too
      ]);
      const res = await make(fake, () => 20).sweepOverCap();
      // `steward-test`: no participating seat -> left alone. `worker-test` is the project seat's by the same convention (the project
      // seat is the only participating `worker`), which is exactly why the kernel must not ALSO be counted: it would make this
      // device ambiguous for ever, and with the kernel as sole owner it would erase a hand-made device.
      expect(res.outcomes.find((o) => o.udid === U(1))).toMatchObject({ action: "skipped", reason: "unattributed" });
      expect(fake.erased()).toEqual([U(2)]);
      expect(events()[0]!.node_id).toBe(proj.nodes["build.worker"]!.id);
    });

    it("a device only a kernel seat could own is left alone, over the cap and shut down", async () => {
      seedRig("kernel", ["ops.worker", "ops.agent", "ops.human"]);
      const fake = fakeSimctl([
        { udid: U(1), name: "worker-test", state: "Shutdown", dataPathSize: 60 * GB },
        { udid: U(2), name: "agent-scratch", state: "Shutdown", dataPathSize: 60 * GB },
        { udid: U(3), name: "human-sim", state: "Shutdown", dataPathSize: 60 * GB },
      ]);
      await make(fake, () => 20).sweepOverCap();
      expect(fake.erased()).toEqual([]);
    });

    it("removing a kernel seat or the kernel rig erases nothing", async () => {
      const k = seedRig("kernel", ["ops.worker"]);
      const sim = make(fakeSimctl([]));
      expect(sim.seatsForRemoval(k.rig.id)).toEqual([]);
      expect(sim.seatsForRemoval(k.rig.id, k.nodes["ops.worker"]!.id)).toEqual([]);
    });

    it("an archived rig's copy of a seat does not make the live seat's device ambiguous", async () => {
      const live = seedRig("eztrack", ["verify.qa"]);
      const old = seedRig("eztrack-old", ["verify.qa"]);
      db.prepare("UPDATE rigs SET archived_at = datetime('now') WHERE id = ?").run(old.rig.id);
      const fake = fakeSimctl([{ udid: U(1), name: "qa-duo-271", state: "Shutdown", dataPathSize: 30 * GB }]);
      await make(fake, () => 20).sweepOverCap();
      expect(fake.erased()).toEqual([U(1)]);
      expect(events()[0]).toMatchObject({ rig_id: live.rig.id, node_id: live.nodes["verify.qa"]!.id });
    });

    it("a device only an archived rig's seat could own is left alone", async () => {
      const old = seedRig("eztrack-old", ["verify.qa"]);
      db.prepare("UPDATE rigs SET archived_at = datetime('now') WHERE id = ?").run(old.rig.id);
      seedRig("other", ["build.impl"]);
      const fake = fakeSimctl([{ udid: U(1), name: "qa-duo-271", state: "Shutdown", dataPathSize: 30 * GB }]);
      const res = await make(fake, () => 20).sweepOverCap();
      expect(fake.erased()).toEqual([]);
      expect(res.outcomes[0]).toMatchObject({ reason: "unattributed" });
    });

    it("a stopped rig (no live session) takes part: its seat's over-cap device is erased", async () => {
      const r = seedRig("eztrack", ["verify.qa"]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE node_id = ?").get(r.nodes["verify.qa"]!.id)).toEqual({ n: 0 });
      const fake = fakeSimctl([{ udid: U(1), name: "qa-duo-271", state: "Shutdown", dataPathSize: 30 * GB }]);
      await make(fake, () => 20).sweepOverCap();
      expect(fake.erased()).toEqual([U(1)]);
    });

    it("deleting an archived rig erases its seats' devices when no participating seat could own them", async () => {
      const old = seedRig("eztrack-old", ["verify.qa"]);
      db.prepare("UPDATE rigs SET archived_at = datetime('now') WHERE id = ?").run(old.rig.id);
      const fake = fakeSimctl([{ udid: U(1), name: "qa-duo-271", state: "Shutdown", dataPathSize: 1 * GB }]);
      const sim = make(fake);
      const removed = sim.seatsForRemoval(old.rig.id);
      expect(removed).toHaveLength(1);
      rigRepo.deleteRig(old.rig.id);
      await sim.eraseForRemovedSeats(removed, "rig_deleted");
      expect(fake.erased()).toEqual([U(1)]);
    });

    it("deleting an archived duplicate leaves the live rig's device alone", async () => {
      seedRig("eztrack", ["verify.qa"]);
      const old = seedRig("eztrack-old", ["verify.qa"]);
      db.prepare("UPDATE rigs SET archived_at = datetime('now') WHERE id = ?").run(old.rig.id);
      const fake = fakeSimctl([{ udid: U(1), name: "qa-duo-271", state: "Shutdown", dataPathSize: 1 * GB }]);
      const sim = make(fake);
      const removed = sim.seatsForRemoval(old.rig.id);
      rigRepo.deleteRig(old.rig.id);
      const res = await sim.eraseForRemovedSeats(removed, "rig_deleted");
      expect(fake.erased()).toEqual([]);
      expect(res.outcomes[0]).toMatchObject({ reason: "ambiguous" });
    });
  });

  describe("two rigs from one spec (live data shape, OF-208 blocked round)", () => {
    // The 8 seats of jims-team and the 8 real devices of 2026-11-04 (names, states, sizes), as measured on the Mac.
    const SEATS = ["exec.cos", "build.arch", "build.impl", "build.ux", "verify.ops", "verify.qa", "verify.screen", "verify.sec"];
    const LIVE_DEVICES: FakeDevice[] = [
      { udid: U(1), name: "arch-duo2-271", state: "Shutdown", dataPathSize: 18_337_792 },
      { udid: U(2), name: "cos-build-duo", state: "Shutdown", dataPathSize: 18_337_792 },
      { udid: U(3), name: "impl-xedd-duo-271", state: "Booted", dataPathSize: 21_000_000_000 },
      { udid: U(4), name: "ops-duo-271", state: "Shutdown", dataPathSize: 18_337_792 },
      { udid: U(5), name: "qa-duo-271", state: "Shutdown", dataPathSize: 30 * GB }, // made big and shut down to be erasable
      { udid: U(6), name: "screen-duo-271", state: "Shutdown", dataPathSize: 5_142_749_184 },
      { udid: U(7), name: "sec-duo-271", state: "Shutdown", dataPathSize: 9_859_563_520 },
      { udid: U(8), name: "ux-duo-271", state: "Shutdown", dataPathSize: 25 * GB },
    ];

    it("with two live rigs built from the same spec every device is ambiguous: the cap erases nothing, and a seat's removal erases nothing", async () => {
      const a = seedRig("eztrack", SEATS);
      seedRig("ezhome", SEATS);
      const fake = fakeSimctl(LIVE_DEVICES.map((d) => ({ ...d })));
      const sim = make(fake, () => 20);
      const res = await sim.sweepOverCap();
      expect(fake.erased()).toEqual([]);
      expect(res.outcomes.every((o) => o.reason === "ambiguous")).toBe(true);
      expect(res.outcomes).toHaveLength(8);

      const removed = sim.seatsForRemoval(a.rig.id, a.nodes["verify.qa"]!.id);
      rigRepo.deleteNode(a.nodes["verify.qa"]!.id);
      await sim.eraseForRemovedSeats(removed, "seat_removed");
      expect(fake.erased()).toEqual([]); // ezhome's verify.qa could own it too
    });

    it("once one of the two rigs is archived, the other's seats own the devices and the over-cap shut-down ones are erased", async () => {
      const a = seedRig("eztrack", SEATS);
      const b = seedRig("ezhome", SEATS);
      db.prepare("UPDATE rigs SET archived_at = datetime('now') WHERE id = ?").run(b.rig.id);
      const fake = fakeSimctl(LIVE_DEVICES.map((d) => ({ ...d })));
      const res = await make(fake, () => 20).sweepOverCap();
      expect(fake.erased().sort()).toEqual([U(5), U(8)]); // qa 30 GB and ux 25 GB; impl is Booted (21 GB), screen/sec under 20
      expect(res.outcomes.find((o) => o.udid === U(3))).toMatchObject({ action: "skipped", reason: "not_shut_down:Booted" });
      expect(events().map((e) => [e.p["seat"], e.rig_id])).toEqual([["verify.qa", a.rig.id], ["build.ux", a.rig.id]]);
    });

    it("planOverCap shows the decision and the attributed seat per device and runs only `list`", async () => {
      const a = seedRig("eztrack", SEATS);
      const fake = fakeSimctl(LIVE_DEVICES.map((d) => ({ ...d })));
      const plan = await make(fake, () => 20).planOverCap();
      expect(plan.status).toBe("ok");
      expect(fake.calls.map((c) => c[0])).toEqual(["list"]);
      const byName = Object.fromEntries(plan.rows.map((r) => [r.device.name, r]));
      expect(byName["qa-duo-271"]).toMatchObject({ verdict: "erase", seat: "verify.qa", rigId: a.rig.id });
      expect(byName["impl-xedd-duo-271"]).toMatchObject({ verdict: "not_shut_down:Booted", seat: "build.impl", rigId: a.rig.id });
      expect(byName["sec-duo-271"]).toMatchObject({ verdict: "under_cap", seat: "verify.sec" });
      expect(events()).toEqual([]);
    });

    it("planOverCap on a disabled service, a zero cap or an unreadable cap does nothing", async () => {
      seedRig("eztrack", SEATS);
      const noExec = new SimulatorLifecycle({ db, eventBus, capGb: () => 20, log: () => {} });
      expect(await noExec.planOverCap()).toEqual({ status: "disabled", rows: [] });
      const fake = fakeSimctl([]);
      expect(await make(fake, () => 0).planOverCap()).toEqual({ status: "disabled", rows: [] });
      expect(await make(fake, () => { throw new Error("bad config"); }).planOverCap()).toEqual({ status: "unavailable", rows: [] });
      expect(fake.calls).toEqual([]);
    });
  });

  describe("event", () => {
    it("records udid, name, size, reason (and the cap) for every erase, on the seat's rig and node", async () => {
      const { rig, nodes } = seedRig();
      const fake = fakeSimctl([{ udid: U(7), name: "qa-duo-271", state: "Shutdown", dataPathSize: 8_375_889_920 }]);
      await make(fake, () => 5).sweepOverCap();
      const ev = events();
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ rig_id: rig.id, node_id: nodes["verify.qa"]!.id });
      expect(ev[0]!.p).toMatchObject({
        type: "simulator.erased", seat: "verify.qa", udid: U(7), name: "qa-duo-271",
        sizeBytes: 8_375_889_920, reason: "over_size_cap", capBytes: 5 * GB,
      });
    });

    it("a removal event has no cap and survives the rig's deletion", async () => {
      const { rig } = seedRig();
      const fake = fakeSimctl([{ udid: U(7), name: "qa-duo-271", state: "Shutdown", dataPathSize: 123 }]);
      const sim = make(fake);
      const removed = sim.seatsForRemoval(rig.id);
      rigRepo.deleteRig(rig.id);
      await sim.eraseForRemovedSeats(removed, "rig_deleted");
      const ev = events();
      expect(ev).toHaveLength(1);
      expect(ev[0]!.p).toMatchObject({ udid: U(7), name: "qa-duo-271", sizeBytes: 123, reason: "rig_deleted" });
      expect(ev[0]!.p).not.toHaveProperty("capBytes");
    });

    it("writes no event for a device it skipped or failed to erase", async () => {
      seedRig();
      const fake = fakeSimctl([{ udid: U(1), name: "qa-duo-271", state: "Shutdown", dataPathSize: 30 * GB }]);
      fake.state.failErase = new Error("erase failed");
      const res = await make(fake, () => 20).sweepOverCap();
      expect(res.outcomes[0]).toMatchObject({ action: "failed", reason: "over_size_cap" });
      expect(events()).toEqual([]);
    });
  });

  describe("simctl absent or failing", () => {
    it("a missing xcrun does nothing, throws nothing, writes nothing", async () => {
      const { rig, nodes } = seedRig();
      const fake = fakeSimctl([]);
      fake.state.failList = Object.assign(new Error("spawn xcrun ENOENT"), { code: "ENOENT" });
      const sim = make(fake, () => 20);
      expect(await sim.sweepOverCap()).toEqual({ status: "unavailable", outcomes: [] });
      expect(log.some((l) => l.includes("simctl unavailable") && l.includes("ENOENT"))).toBe(true);
      const removed = sim.seatsForRemoval(rig.id, nodes["verify.qa"]!.id);
      expect(await sim.eraseForRemovedSeats(removed, "seat_removed")).toEqual({ status: "unavailable", outcomes: [] });
      expect(fake.calls.every((c) => c[0] === "list")).toBe(true);
      expect(events()).toEqual([]);
    });

    it("unparseable list output does nothing", async () => {
      seedRig();
      const sim = new SimulatorLifecycle({ db, eventBus, simctl: async () => "not json", capGb: () => 20, log: (l) => log.push(l) });
      expect(await sim.sweepOverCap()).toEqual({ status: "unavailable", outcomes: [] });
    });

    it("a failed erase is reported and the next device is still handled", async () => {
      seedRig();
      const fake = fakeSimctl([
        { udid: U(1), name: "qa-duo-271", state: "Shutdown", dataPathSize: 30 * GB },
        { udid: U(2), name: "impl-duo-1", state: "Shutdown", dataPathSize: 30 * GB },
      ]);
      const realExec = fake.exec;
      const sim = new SimulatorLifecycle({
        db, eventBus, capGb: () => 20, log: (l) => log.push(l),
        simctl: async (args) => { if (args[0] === "erase" && args[1] === U(1)) { fake.calls.push(args); throw new Error("busy"); } return realExec(args); },
      });
      const res = await sim.sweepOverCap();
      expect(res.outcomes.map((o) => [o.udid, o.action])).toEqual([[U(1), "failed"], [U(2), "erased"]]);
      expect(log.some((l) => l.includes(U(1)) && l.includes("busy"))).toBe(true);
    });

    it("an event write failure after an erase does not throw", async () => {
      seedRig();
      const fake = fakeSimctl([{ udid: U(1), name: "qa-duo-271", state: "Shutdown", dataPathSize: 30 * GB }]);
      const sim = new SimulatorLifecycle({ db, eventBus: new ThrowingEventBus(db), simctl: fake.exec, capGb: () => 20, log: (l) => log.push(l) });
      const res = await sim.sweepOverCap();
      expect(res.outcomes[0]).toMatchObject({ action: "erased" });
      expect(log.some((l) => l.includes("event could not be written"))).toBe(true);
    });
  });

  describe("serialisation", () => {
    it("two removals never interleave their simctl calls", async () => {
      const { rig, nodes } = seedRig();
      const fake = fakeSimctl([
        { udid: U(1), name: "qa-duo-271", state: "Shutdown", dataPathSize: 8 * GB },
        { udid: U(2), name: "impl-duo-271", state: "Shutdown", dataPathSize: 8 * GB },
      ]);
      fake.state.listDelay = 5;
      const sim = make(fake);
      const qa = sim.seatsForRemoval(rig.id, nodes["verify.qa"]!.id);
      const impl = sim.seatsForRemoval(rig.id, nodes["build.impl"]!.id);
      rigRepo.deleteNode(nodes["verify.qa"]!.id);
      rigRepo.deleteNode(nodes["build.impl"]!.id);
      await Promise.all([sim.eraseForRemovedSeats(qa, "seat_removed"), sim.eraseForRemovedSeats(impl, "seat_removed")]);
      // each run is list, re-list, erase; serialised, the second starts after the first erased.
      expect(fake.calls.map((c) => c[0])).toEqual(["list", "list", "erase", "list", "list", "erase"]);
      expect(fake.erased()).toEqual([U(1), U(2)]);
    });
  });
});

describe("OF-208 removal reaches the simulators from every removal path", () => {
  let db: Database.Database;
  beforeEach(() => { db = createFullTestDb(); });
  afterEach(() => db.close());

  function wire(devices: FakeDevice[]) {
    const fake = fakeSimctl(devices);
    const eventBus = new EventBus(db);
    const simulatorLifecycle = new SimulatorLifecycle({ db, eventBus, simctl: fake.exec, capGb: () => 0, platform: "linux", log: () => {} });
    const setup = createTestApp(db, { simulatorLifecycle });
    return { fake, setup, simulatorLifecycle };
  }
  const devs = (): FakeDevice[] => [
    { udid: U(1), name: "qa-duo-271", state: "Shutdown", dataPathSize: 8 * GB },
    { udid: U(2), name: "impl-duo-271", state: "Shutdown", dataPathSize: 9 * GB },
  ];
  const reasons = (d: Database.Database) => (d.prepare("SELECT payload FROM events WHERE type = 'simulator.erased' ORDER BY seq").all() as Array<{ payload: string }>)
    .map((r) => (JSON.parse(r.payload) as { reason: string }).reason);
  const settle = (fake: ReturnType<typeof fakeSimctl>, n: number) => vi.waitFor(() => expect(fake.erased().length).toBe(n));

  it("DELETE /api/rigs/:rigId/nodes/:nodeRef (rig remove) erases that seat's device", async () => {
    const { fake, setup } = wire(devs());
    const rig = setup.rigRepo.createRig("eztrack");
    setup.rigRepo.addNode(rig.id, "verify.qa", { runtime: "terminal" });
    setup.rigRepo.addNode(rig.id, "build.impl", { runtime: "terminal" });
    const res = await setup.app.request(`/api/rigs/${rig.id}/nodes/verify.qa`, { method: "DELETE" });
    expect(res.status).toBe(200);
    await settle(fake, 1);
    expect(fake.erased()).toEqual([U(1)]);
    expect(reasons(db)).toEqual(["seat_removed"]);
    // the event names the seat (and its rig and node), so whoever reads the log can say whose next boot will be slow
    const ev = db.prepare("SELECT rig_id, node_id, payload FROM events WHERE type = 'simulator.erased'").get() as { rig_id: string; node_id: string; payload: string };
    expect(ev.rig_id).toBe(rig.id);
    expect(JSON.parse(ev.payload)).toMatchObject({ seat: "verify.qa", name: "qa-duo-271", udid: U(1) });
    expect(ev.node_id).toBe(JSON.parse(ev.payload).nodeId);
  });

  it("a refused removal erases nothing", async () => {
    const { fake, setup } = wire(devs());
    const res = await setup.app.request(`/api/rigs/no-such-rig/nodes/verify.qa`, { method: "DELETE" });
    expect(res.status).toBe(404);
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.calls).toEqual([]);
  });

  it("DELETE /api/rigs/:rigId/pods/:podRef (rig shrink) erases the pod members' devices", async () => {
    const { fake, setup } = wire(devs());
    const rig = setup.rigRepo.createRig("eztrack");
    await setup.rigExpansionService.expand({
      rigId: rig.id,
      pod: { id: "verify", label: "Verify", members: [{ id: "qa", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" }], edges: [] },
    });
    setup.rigRepo.addNode(rig.id, "build.impl", { runtime: "terminal" });
    const res = await setup.app.request(`/api/rigs/${rig.id}/pods/verify`, { method: "DELETE" });
    expect(res.status).toBe(200);
    await settle(fake, 1);
    expect(fake.erased()).toEqual([U(1)]);
    expect(reasons(db)).toEqual(["seat_removed"]);
  });

  it("POST /api/rigs/:rigId/release with delete erases the rig's seats' devices", async () => {
    const { fake, setup } = wire(devs());
    const rig = setup.rigRepo.createRig("eztrack");
    setup.rigRepo.addNode(rig.id, "verify.qa", { runtime: "terminal" });
    setup.rigRepo.addNode(rig.id, "build.impl", { runtime: "terminal" });
    const res = await setup.app.request(`/api/rigs/${rig.id}/release`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: true }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(true);
    await settle(fake, 2);
    expect(fake.erased().sort()).toEqual([U(1), U(2)]);
    expect(reasons(db)).toEqual(["rig_deleted", "rig_deleted"]);
  });

  it("release without delete removes no seat and erases nothing", async () => {
    const { fake, setup } = wire(devs());
    const rig = setup.rigRepo.createRig("eztrack");
    setup.rigRepo.addNode(rig.id, "verify.qa", { runtime: "terminal" });
    const res = await setup.app.request(`/api/rigs/${rig.id}/release`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.calls).toEqual([]);
  });

  it("DELETE /api/rigs/:rigId erases the rig's seats' devices", async () => {
    const { fake, setup } = wire(devs());
    const rig = setup.rigRepo.createRig("eztrack");
    setup.rigRepo.addNode(rig.id, "verify.qa", { runtime: "terminal" });
    setup.rigRepo.addNode(rig.id, "build.impl", { runtime: "terminal" });
    const res = await setup.app.request(`/api/rigs/${rig.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    await settle(fake, 2);
    expect(fake.erased().sort()).toEqual([U(1), U(2)]);
    expect(reasons(db)).toEqual(["rig_deleted", "rig_deleted"]);
  });

  it("rig down --delete (teardown with delete) erases the rig's seats' devices, stopped or not", async () => {
    const { fake, setup } = wire(devs());
    const rig = setup.rigRepo.createRig("eztrack");
    setup.rigRepo.addNode(rig.id, "verify.qa", { runtime: "terminal" });
    setup.rigRepo.addNode(rig.id, "build.impl", { runtime: "terminal" });
    const result = await setup.teardownOrchestrator.teardown(rig.id, { delete: true });
    expect(result.deleted).toBe(true);
    await settle(fake, 2);
    expect(fake.erased().sort()).toEqual([U(1), U(2)]);
    expect(reasons(db)).toEqual(["rig_deleted", "rig_deleted"]);
  });

  it("rig down without delete erases nothing", async () => {
    const { fake, setup } = wire(devs());
    const rig = setup.rigRepo.createRig("eztrack");
    setup.rigRepo.addNode(rig.id, "verify.qa", { runtime: "terminal" });
    await setup.teardownOrchestrator.teardown(rig.id, {});
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.calls).toEqual([]);
  });

  it("a harness that wires no SimulatorLifecycle removes seats as before", async () => {
    const setup = createTestApp(db);
    const rig = setup.rigRepo.createRig("eztrack");
    setup.rigRepo.addNode(rig.id, "verify.qa", { runtime: "terminal" });
    const res = await setup.app.request(`/api/rigs/${rig.id}/nodes/verify.qa`, { method: "DELETE" });
    expect(res.status).toBe(200);
  });
});
