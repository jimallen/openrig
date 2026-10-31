import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HcCoreRefusedError, connectHcCore } from "../src/adapters/hc-core-watch.js";
import { HC, PrivateCore } from "./helpers/hc-private-core.js";

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
