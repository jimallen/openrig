import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { HcUnavailableError } from "../src/adapters/hc-client.js";
import { connectHcCore, startCoreWithCli } from "../src/adapters/hc-core-watch.js";

// A core started without a NAMED runtime location lands in the host's: hc asks the user manager and uses /run/user/<uid>, and a
// core with a fresh state dir there adopts every holder it finds and ends the programs its own registry does not know (incident
// 2026-11-02: a seat ran `rig daemon start` with no XDG_RUNTIME_DIR and every terminal under the host's holder ended). The fake `hc`
// below stands for the real one: it records that it ran, and nothing else. The fixtures are restated here, not imported from the
// guard, so a name dropped from the rule fails a row.
const dir = mkdtempSync(join(tmpdir(), "hc-core-start-guard-"));
const ran = join(dir, "ran.txt");
const fakeHc = join(dir, "hc");
writeFileSync(fakeHc, `#!/bin/sh\necho "args=$*" >> ${ran}\n`);
chmodSync(fakeHc, 0o755);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => rmSync(ran, { force: true }));

const PATH = process.env.PATH ?? "/usr/bin:/bin";
const hcRan = () => existsSync(ran);

async function refusal(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string> {
  const err = await startCoreWithCli({ env, hcPath: fakeHc, platform })().then(() => null, (e: unknown) => e);
  expect(err, "the start was refused").toBeInstanceOf(HcUnavailableError);
  expect(hcRan(), "hc never ran").toBe(false);
  if (!(err instanceof HcUnavailableError)) throw new Error("not reached: asserted above");
  return err.message;
}

describe("a core is never started without a named runtime location", () => {
  describe("linux: XDG_RUNTIME_DIR or HC_SOCKET", () => {
    it("refuses when neither is set, even with HOME and the state dir set, and the message names the cause and both names", async () => {
      const message = await refusal({ PATH, HOME: "/h", XDG_STATE_HOME: "/h/s" }, "linux");
      expect(message).toContain("XDG_RUNTIME_DIR");
      expect(message).toContain("HC_SOCKET");
      expect(message).toContain("host's runtime");
    });
    it("refuses an empty XDG_RUNTIME_DIR and an empty HC_SOCKET, which hc reads as unset", async () => {
      await refusal({ PATH, HOME: "/h", XDG_RUNTIME_DIR: "", HC_SOCKET: "" }, "linux");
    });
    it("starts the core when XDG_RUNTIME_DIR is set", async () => {
      await startCoreWithCli({ env: { PATH, XDG_RUNTIME_DIR: "/r" }, hcPath: fakeHc, platform: "linux" })();
      expect(hcRan()).toBe(true);
    });
    it("starts the core when only HC_SOCKET is set", async () => {
      await startCoreWithCli({ env: { PATH, HC_SOCKET: "/r/default.sock" }, hcPath: fakeHc, platform: "linux" })();
      expect(hcRan()).toBe(true);
    });
  });

  describe("darwin: there is no runtime dir; the socket lives under the state dir, which HOME or XDG_STATE_HOME names", () => {
    it("starts the core for the launchd daemon's env: HOME set, no XDG_RUNTIME_DIR, no HC_SOCKET", async () => {
      await startCoreWithCli({ env: { PATH, HOME: "/Users/x" }, hcPath: fakeHc, platform: "darwin" })();
      expect(hcRan()).toBe(true);
    });
    it("starts the core when only XDG_STATE_HOME is set", async () => {
      await startCoreWithCli({ env: { PATH, XDG_STATE_HOME: "/s" }, hcPath: fakeHc, platform: "darwin" })();
      expect(hcRan()).toBe(true);
    });
    it("starts the core when only XDG_RUNTIME_DIR is set, or only HC_SOCKET", async () => {
      await startCoreWithCli({ env: { PATH, XDG_RUNTIME_DIR: "/r" }, hcPath: fakeHc, platform: "darwin" })();
      expect(hcRan()).toBe(true);
      rmSync(ran);
      await startCoreWithCli({ env: { PATH, HC_SOCKET: "/r/default.sock" }, hcPath: fakeHc, platform: "darwin" })();
      expect(hcRan()).toBe(true);
    });
    it("refuses an env that names no location at all (no HOME either: hc would take the account's home), naming the cause", async () => {
      const message = await refusal({ PATH, XDG_RUNTIME_DIR: "", HOME: "" }, "darwin");
      expect(message).toContain("HOME");
      expect(message).toContain("XDG_STATE_HOME");
      expect(message).toContain("HC_SOCKET");
    });
  });

  it("a platform other than linux judges by the state dir, as darwin does", async () => {
    await startCoreWithCli({ env: { PATH, HOME: "/h" }, hcPath: fakeHc, platform: "freebsd" })();
    expect(hcRan()).toBe(true);
  });
});

describe("the daemon's own core start (connectHcCore, no injected startCore) is the guarded one", () => {
  it("logs why it did not start a core, once however many times the watch retries, and never runs hc, when its env names no location", async () => {
    const logs: string[] = [];
    // No HOME, no XDG_*, no HC_SOCKET: refused on every platform. The socket path is one nothing listens on.
    const watch = await connectHcCore({
      socketPath: join(dir, "nothing-listens-here.sock"),
      env: { PATH: `${dir}:${PATH}` },
      log: (m) => logs.push(m),
      firstAttemptMs: 400,
    });
    // connectHcCore returns after the first failed attempt and the watch goes on: it retries 100, 200 and 500 ms apart, so this wait holds several refusals.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    watch.stop();
    expect(hcRan(), "the fake hc on PATH never ran").toBe(false);
    expect(logs.some((m) => m.includes('"core_started"')), "a refused start is not reported as a core started").toBe(false);
    const refused = logs.filter((m) => m.includes("core_start_failed"));
    expect(refused, "the refusal is in the daemon log, one line for the same reason").toHaveLength(1);
    expect(refused[0]).toContain("XDG_RUNTIME_DIR");
  });
  it("starts the core through hc when its env names a location (positive control: the same call, one name added)", async () => {
    const logs: string[] = [];
    const watch = await connectHcCore({
      socketPath: join(dir, "nothing-listens-here.sock"),
      env: { PATH: `${dir}:${PATH}`, HC_SOCKET: join(dir, "nothing-listens-here.sock") },
      log: (m) => logs.push(m),
      firstAttemptMs: 400,
    });
    watch.stop();
    expect(hcRan()).toBe(true);
    expect(logs.some((m) => m.includes('"core_started"'))).toBe(true);
    expect(logs.some((m) => m.includes("core_start_failed"))).toBe(false);
  });
});
