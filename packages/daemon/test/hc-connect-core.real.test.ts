import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HcCoreRefusedError, connectHcCore } from "../src/adapters/hc-core-watch.js";
import { HC, PrivateCore } from "./helpers/hc-private-core.js";
import { hcServerUntilUp } from "./helpers/hc-scratch.js";

describe.skipIf(!HC)("connectHcCore on a private core", () => {
  const core = new PrivateCore();
  beforeAll(() => core.start());
  afterAll(() => core.stop());

  it("streams from a core on the pinned version", async () => {
    const watch = await connectHcCore({ socketPath: core.client.socketPath, env: core.env, log: () => {} });
    expect(watch.state()).toBe("streaming");
    watch.stop();
  });

  it("refuses a core on any other version, so the daemon does not start", async () => {
    await expect(connectHcCore({ socketPath: core.client.socketPath, env: core.env, log: () => {}, pin: { versions: ["9.9.9"] } }))
      .rejects.toBeInstanceOf(HcCoreRefusedError);
  });

  it("does not refuse a core that is down, and starts none when told not to", async () => {
    let started = 0;
    const watch = await connectHcCore({
      socketPath: `${core.root}/none.sock`, env: { OPENRIG_HC_NO_START_CORE: "1" }, log: () => {}, startCore: async () => { started += 1; }, firstAttemptMs: 2_000,
    });
    expect(watch.state()).not.toBe("refused");
    expect(started).toBe(0);
    watch.stop();
  });

  it("starts the core when it may", async () => {
    let started = 0;
    const watch = await connectHcCore({
      socketPath: `${core.root}/none.sock`, env: {}, log: () => {}, startCore: async () => { started += 1; }, firstAttemptMs: 2_000,
    });
    expect(started).toBeGreaterThan(0);
    watch.stop();
  });
});

// workspaces-o9o.165: on Linux the socket is the runtime dir's and the core id is the state dir's (measured: hc keeps it in
// <state dir>/herdr-core/<session>/core.json, the same across restarts, another for another state dir at the same socket). A core
// at this instance's socket with another state dir has another registry of terminals; the daemon must not take it for its own.
describe.skipIf(!HC)("connectHcCore judges the core by this instance's state dir (workspaces-o9o.165)", () => {
  const core = new PrivateCore();
  const other = (name: string): NodeJS.ProcessEnv => {
    for (const d of ["h", "s"]) mkdirSync(join(core.root, name, d), { recursive: true, mode: 0o700 });
    return { ...core.env, HOME: join(core.root, name, "h"), XDG_STATE_HOME: join(core.root, name, "s") };
  };
  let ownId = "";
  let foreignId = "";
  let foreignEnv: NodeJS.ProcessEnv = {};
  beforeAll(async () => {
    core.start();
    ownId = (await core.client.hello()).core.id;  // this instance's state dir now names ownId
    spawnSync(HC, ["server", "stop"], { env: core.env, stdio: "ignore" });
    foreignEnv = other("foreign");  // another HOME and state dir, the same runtime dir and session: the same socket
    hcServerUntilUp(HC, foreignEnv, "start");
    foreignId = (await core.client.hello()).core.id;
  });
  afterAll(() => core.stop());

  it("refuses a core whose id is not the one this instance's state dir names, so the daemon does not start", async () => {
    expect(foreignId).not.toBe(ownId);
    const err: unknown = await connectHcCore({ socketPath: core.client.socketPath, env: { ...core.env, OPENRIG_HC_NO_START_CORE: "1" }, log: () => {} })
      .then((watch) => { watch.stop(); return null; }, (e: unknown) => e);
    expect(err).toBeInstanceOf(HcCoreRefusedError);
    expect((err as HcCoreRefusedError).kind).toBe("core_not_this_instance");
    expect((err as HcCoreRefusedError).message).toContain(ownId);
    expect((err as HcCoreRefusedError).message).toContain(foreignId);
  });

  it("joins it from an instance whose state dir has never held a core (the scenario scaffold's shape), and from the instance it belongs to", async () => {
    for (const env of [other("fresh"), foreignEnv]) {
      const watch = await connectHcCore({ socketPath: core.client.socketPath, env: { ...env, OPENRIG_HC_NO_START_CORE: "1" }, log: () => {} });
      expect(watch.state()).toBe("streaming");
      expect(watch.pinnedCoreId()).toBe(foreignId);
      watch.stop();
    }
  });
});
