// A fake core can only assume what a real core says in `hello`. Here the refusal that feeds the notice comes from a real hc core on a
// private HOME, HC_SESSION and XDG paths (never the host's core or the app): the pin is moved off the real core's version, so the
// real `hello` is what gets refused, and the notice must name that version.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HcClient, HcUnavailableError } from "../src/adapters/hc-client.js";
import { HC_PINNED_VERSION, connectHcCore } from "../src/adapters/hc-core-watch.js";
import { HcCoreRefusalHealthSource } from "../src/domain/hc-core-refusal-health.js";
import { HC, PrivateCore } from "./hc-private-core.js";

describe.skipIf(!HC)("the refused-core notice against a private hc core", () => {
  const core = new PrivateCore("rfh");
  beforeAll(() => core.start());
  afterAll(() => core.stop());

  it("shows nothing for the core on the pinned version", async () => {
    const client = new HcClient(core.socketPath);
    const watch = await connectHcCore({ socketPath: core.socketPath, env: core.env, client, log: () => {} });
    expect(watch.state()).toBe("streaming");
    watch.stop();
    expect(new HcCoreRefusalHealthSource(() => client.refusedBecause).coverage()).toEqual([]);
  });

  it("names the real core's version once a pin that is not it refuses the core, and the client fails closed", async () => {
    const client = new HcClient(core.socketPath);
    await expect(connectHcCore({ socketPath: core.socketPath, env: core.env, client, log: () => {}, pin: { versions: ["9.9.9"] } })).rejects.toMatchObject({ kind: "unsupported_version" });
    const rows = new HcCoreRefusalHealthSource(() => client.refusedBecause).coverage();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "notice", partial: false });
    expect(rows[0] && "reason" in rows[0] ? rows[0].reason : "").toContain(HC_PINNED_VERSION);  // the real core's version, from its real hello
    await expect(client.call("server.status")).rejects.toBeInstanceOf(HcUnavailableError);
  });
});
