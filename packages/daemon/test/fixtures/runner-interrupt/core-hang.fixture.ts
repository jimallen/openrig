// workspaces-21r: one test file as hc-delivery.real.test.ts and delivery-review.real.test.ts are built: a private core
// started in beforeAll through test/hc-private-core.ts, terminal programs under it (one with an env of its own, as
// delivery-review's seats have), stop() in afterAll, and then a test that never finishes. The outer test interrupts the run.
import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, it } from "vitest";
import { PrivateCore } from "../../hc-private-core.js";

const meta = process.env.RI_META;
if (!meta) throw new Error("RI_META is not set: this file is run only by runner-interrupt-orphans.real.test.ts");
const say = (line: Record<string, unknown>) => appendFileSync(meta, `${JSON.stringify(line)}\n`);

const core = new PrivateCore("ri");

beforeAll(async () => {
  say({ type: "root", root: core.root, runtimeDir: core.env.XDG_RUNTIME_DIR, env: core.env, worker: process.pid });
  core.start();
  await core.client.call("terminal.run", { argv: ["/bin/sh", "-c", "exec sleep 600"], name: "ri-plain", no_parent: true, no_notify: true, outlive_parent: true });
  await core.client.call("terminal.run", {
    argv: ["/bin/sh", "-c", "exec sleep 601"], name: "ri-env", env: { PATH: "/usr/bin:/bin", HOME: core.env.HOME },
    no_parent: true, no_notify: true, outlive_parent: true,
  });
  say({ type: "ready", core: await core.corePid(), holder: await core.holderPid() });
});

afterAll(() => core.stop());

it("never finishes", () => new Promise<void>(() => { /* the outer test ends this run */ }));
