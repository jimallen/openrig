import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HcClient, resolveHcSocket } from "../src/adapters/hc-client.js";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findHc, HcForeignCoreError, startHcScratch } from "./helpers/hc-scratch.js";
import { runRig, spawnScenarioDaemon } from "./helpers/scenario-daemon.js";

// The seat host is hc. A scenario daemon the scaffold spawns needs a core, and the core must be the scaffold's own: the
// default core is the one Jim's app shows, and `hc server status`, `hc schema` and `hc --skill` start one when none runs.

const HC = findHc();
const PATH = process.env.PATH ?? "";
const scaffolds: HermeticScaffold[] = [];
afterEach(() => { for (const s of scaffolds.splice(0)) s.cleanup(); });
const scaffold = (baseEnv: Record<string, string | undefined> = { PATH }): HermeticScaffold => {
  const s = prepareHermeticEnv({ baseEnv });
  scaffolds.push(s);
  return s;
};

describe("hermetic scaffold: the daemon's hc core is the scaffold's own (no hc needed)", () => {
  it("a scaffold env carries no hc selector it did not set: every inherited HC_ name and the inherited runtime dir are dropped", () => {
    const s = scaffold({ PATH, HC_SESSION: "default", HC_TERMINAL_ID: "t9", HC_TERMINAL_SOCKET: "/x.sock", HC_SCOPE: "s", HC_FUTURE_SELECTOR: "1", XDG_RUNTIME_DIR: "/run/user/1000" });
    expect(Object.keys(s.env).filter((name) => name.startsWith("HC_"))).toEqual([]);
    // hc looks for its socket under XDG_RUNTIME_DIR first: kept, it would send a core-less scaffold to the host's default core.
    expect(s.env.XDG_RUNTIME_DIR).toBeUndefined();
    expect(resolveHcSocket(s.env as NodeJS.ProcessEnv, s.home)).toBe(join(s.env.XDG_STATE_HOME!, "herdr-core", "default", "default.sock"));
    expect(s.hcCore).toBeNull();
  });

  it.skipIf(!HC)("a daemon env that would resolve the socket anywhere but the private core's is refused by name, and nothing is left set", () => {
    const s = scaffold();
    s.env.HC_SOCKET = "/tmp/elsewhere/default.sock";
    expect(() => s.startHcCore()).toThrow(/resolves the hc socket to \/tmp\/elsewhere\/default\.sock, not the private core's /);
    expect(s.hcCore).toBeNull();
    expect(s.env.HC_SESSION).toBeUndefined();
    expect(s.env.XDG_RUNTIME_DIR).toBeUndefined();
  });

  it("an ambient HC_SOCKET refuses startHcCore by name, before a core exists, and leaves the env without a selector", () => {
    const s = scaffold({ PATH, HC_SOCKET: "/home/jim/.local/state/herdr-core/default/default.sock" });
    expect(() => s.startHcCore()).toThrow(HcForeignCoreError);
    expect(s.hcCore).toBeNull();
    expect(s.env.HC_SESSION).toBeUndefined();
    expect(s.env.HC_SOCKET).toBeUndefined();
  });
});

describe.skipIf(!HC)("hermetic scaffold: a real private core", () => {
  it("starts a core the daemon env resolves to exactly, and cleanup stops it before the root goes", async () => {
    const s = scaffold();
    const core = s.startHcCore();
    expect(s.startHcCore()).toBe(core);
    expect(s.hcCore).toBe(core);
    expect(s.env.HC_SESSION).toBe(core.session);
    expect(s.env.HC_SESSION).not.toBe("default");
    expect(resolveHcSocket(s.env as NodeJS.ProcessEnv, s.home)).toBe(core.socketPath);
    expect(s.env.XDG_RUNTIME_DIR).toBe(core.env.XDG_RUNTIME_DIR);
    expect(s.env.XDG_STATE_HOME).toBe(core.env.XDG_STATE_HOME);
    // The rest of the scaffold's paths stay where they were: inside its own home.
    expect(s.env.XDG_CONFIG_HOME).toBe(join(s.home, ".config"));
    expect(s.env.HOME).toBe(s.home);
    // The core answers a client built from the scaffold env alone.
    const hello = await new HcClient(resolveHcSocket(s.env as NodeJS.ProcessEnv, s.home)).hello();
    expect(hello.generation).toBeTypeOf("number");

    const root = s.root, coreRoot = core.root, socket = core.socketPath;
    s.cleanup();
    expect(existsSync(socket)).toBe(false);
    expect(existsSync(coreRoot)).toBe(false);
    expect(existsSync(root)).toBe(false);
  });

  it("the daemon env says not to start a core of its own (it would carry the private env, and nothing would stop it), unless the test relies on that", () => {
    const set = scaffold({ PATH });
    set.startHcCore();
    expect(set.env.OPENRIG_HC_NO_START_CORE).toBe("1");
    // An inherited value is no say in it: the scaffold sets the one it means.
    const inherited = scaffold({ PATH, OPENRIG_HC_NO_START_CORE: "0" });
    inherited.startHcCore();
    expect(inherited.env.OPENRIG_HC_NO_START_CORE).toBe("1");
    const relies = scaffold({ PATH, OPENRIG_HC_NO_START_CORE: "1" });
    relies.startHcCore({ daemonMayStartCore: true });
    expect("OPENRIG_HC_NO_START_CORE" in relies.env).toBe(false);
  });

  it("two scaffolds get two cores", () => {
    const a = scaffold(), b = scaffold();
    expect(a.startHcCore().session).not.toBe(b.startHcCore().session);
    expect(a.env.HC_SESSION).not.toBe(b.env.HC_SESSION);
  });
});

const rigBin = resolve(dirname(fileURLToPath(import.meta.url)), "../../cli/dist/bin-wrapper.js");

// Needs the built CLI (npm run build -w packages/cli), as every scenario-daemon suite does.
describe.skipIf(!HC || !existsSync(rigBin))("spawnScenarioDaemon gives the daemon the scaffold's core", () => {
  it("the daemon env and the CLI's env both name the scaffold's private core, and stop() takes the core down with it", async () => {
    const s = scaffold();
    const daemon = await spawnScenarioDaemon(s, { rigBin });
    const core = s.hcCore!;
    expect(core).not.toBeNull();
    expect(daemon.readEnv.HC_SESSION).toBe(core.session);
    expect(resolveHcSocket(daemon.readEnv as NodeJS.ProcessEnv, s.home)).toBe(core.socketPath);
    expect((await runRig(["ps", "--json"], daemon.readEnv, rigBin, 30_000)).code).toBe(0);
    const socket = core.socketPath, root = s.root;
    await daemon.stop();
    expect(existsSync(socket)).toBe(false);
    expect(existsSync(root)).toBe(false);
  }, 120_000);

  it("a core the test started itself and named by HC_SOCKET is the daemon's: no second core is started beside it", async () => {
    const own = startHcScratch();
    try {
      const s = scaffold();
      s.env.HC_SOCKET = own.socketPath;
      const daemon = await spawnScenarioDaemon(s, { rigBin });
      expect(s.hcCore).toBeNull();
      expect(daemon.readEnv.HC_SOCKET).toBe(own.socketPath);
      expect(daemon.readEnv.HC_SESSION).toBeUndefined();
      await daemon.stop();
      expect(existsSync(own.socketPath), "the test's own core is the test's to stop").toBe(true);
    } finally {
      own.cleanup();
    }
  }, 120_000);
});
