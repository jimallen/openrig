import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HcClient, HcError, type HcHello, type HcTerminal, resolveHcSocket } from "../src/adapters/hc-client.js";

const HC = spawnSync("sh", ["-c", "command -v hc"], { encoding: "utf8" }).stdout.trim();

/** A private core only: its own HOME, session and XDG paths, so the host's core is never contacted. */
describe.skipIf(!HC)("HcClient against a private hc core", () => {
  const root = mkdtempSync(join(tmpdir(), "hcr-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: join(root, "h"), HC_SESSION: `t${process.pid}`,
    XDG_CONFIG_HOME: join(root, "c"), XDG_DATA_HOME: join(root, "d"), XDG_STATE_HOME: join(root, "s"), XDG_RUNTIME_DIR: join(root, "r"),
  };
  let client: HcClient;

  beforeAll(() => {
    for (const d of ["h", "c", "d", "s", "r"]) mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
    execFileSync(HC, ["server", "start"], { env, stdio: "ignore" });
    client = new HcClient(resolveHcSocket(env, env.HOME));
  });

  afterAll(() => {
    spawnSync(HC, ["server", "stop"], { env, stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });

  it("says hello on the generation this build pins", async () => {
    const hello = await client.hello();
    expect(hello.generation).toBe(1);
    expect(hello.methods).toEqual(expect.arrayContaining(["terminal.run", "terminal.get", "terminal.send", "terminal.read"] satisfies HcHello["methods"]));
  });

  it("runs, reads back and kills a labelled terminal", async () => {
    const run = await client.call<HcTerminal>("terminal.run", {
      argv: ["sh", "-c", "echo marker-$OPENRIG_T; exec sleep 60"], env: { OPENRIG_T: "7" }, name: "s-abc",
      labels: { "openrig.seat": "qa@rig" }, no_parent: true, no_notify: true, outlive_parent: true,
    });
    const got = await client.call<HcTerminal>("terminal.get", { terminal: run.address });
    expect(got).toMatchObject({ name: "s-abc", labels: { "openrig.seat": "qa@rig" }, state: "live" });
    expect(got.pid).toBeGreaterThan(0);
    await expect.poll(async () => JSON.stringify(await client.call("terminal.read", { terminal: "s-abc", lines: 20 }))).toContain("marker-7");
    await client.call("terminal.kill", { terminal: "s-abc" });
    await expect.poll(async () => (await client.call<HcTerminal>("terminal.get", { terminal: "s-abc" })).state).toBe("finished");
  });

  it("refuses a taken name and a missing terminal with hc's own kinds", async () => {
    const argv = ["sleep", "60"];
    await client.call("terminal.run", { argv, name: "s-dup", no_parent: true, no_notify: true, outlive_parent: true });
    const taken = await client.call("terminal.run", { argv, name: "s-dup", no_parent: true, no_notify: true, outlive_parent: true }).catch((e: unknown) => e);
    expect(taken).toBeInstanceOf(HcError);
    expect(taken).toMatchObject({ kind: "name_taken" });
    const missing = await client.call("terminal.get", { terminal: "s-none" }).catch((e: unknown) => e);
    expect(missing).toMatchObject({ kind: "not_found" });
  });
});
