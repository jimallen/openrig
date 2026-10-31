import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HcClient, resolveHcSocket } from "../src/adapters/hc-client.js";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { findHc, HcForeignCoreError } from "./helpers/hc-scratch.js";

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
  it("a scaffold env carries no hc selector it did not set: every inherited HC_ name is dropped", () => {
    const s = scaffold({ PATH, HC_SESSION: "default", HC_TERMINAL_ID: "t9", HC_TERMINAL_SOCKET: "/x.sock", HC_SCOPE: "s", HC_FUTURE_SELECTOR: "1" });
    expect(Object.keys(s.env).filter((name) => name.startsWith("HC_"))).toEqual([]);
    expect(s.hcCore).toBeNull();
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

  it("OPENRIG_HC_NO_START_CORE is the caller's: kept when set, absent when not (a test that wants the daemon to start a core omits it)", () => {
    const kept = scaffold({ PATH, OPENRIG_HC_NO_START_CORE: "1" });
    kept.startHcCore();
    expect(kept.env.OPENRIG_HC_NO_START_CORE).toBe("1");
    const absent = scaffold({ PATH });
    absent.startHcCore();
    expect("OPENRIG_HC_NO_START_CORE" in absent.env).toBe(false);
  });

  it("two scaffolds get two cores", () => {
    const a = scaffold(), b = scaffold();
    expect(a.startHcCore().session).not.toBe(b.startHcCore().session);
    expect(a.env.HC_SESSION).not.toBe(b.env.HC_SESSION);
  });
});
