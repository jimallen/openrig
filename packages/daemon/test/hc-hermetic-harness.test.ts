import { afterEach, describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHcSocket } from "../src/adapters/hc-client.js";
import {
  createHcScratchRegistry, findLeakedHcScratch, HC_SCRATCH_REGISTRY_ENV, HC_SCRATCH_REGISTRY_OWNER_ENV, ownsHcScratchRegistry,
  registerHcScratchRoot,
} from "../../../test/hc-scratch-tripwire.js";
import { teardown as globalTeardown } from "../../../test/hermetic-env.global.js";
import { startHcScratch } from "./helpers/hc-scratch.js";

// hc cutover W8: the harness consumers of the hc cutover.
//
//  A. test/hermetic-env.setup.ts scrubs HC_* and XDG_RUNTIME_DIR. Inside a seat the env names the seat's own core, and a
//     default `new HcClient()` follows it (hc-client.ts resolveHcSocket: HC_SOCKET, then HC_SESSION under
//     XDG_RUNTIME_DIR, then the state dir). The hygiene rows assert what a test file sees AFTER the setup ran; the child
//     row proves the setup does it by running this file's hygiene rows in a vitest whose own env is poisoned.
//  B. test/hermetic-env.global.ts teardown fails the run when a private hc core root made by hc-scratch is left behind
//     (test/hc-scratch-tripwire.ts). "This run's" is a registry the run's setup makes and startHcScratch writes to (W20);
//     the unit rows pin that, the child rows run a real vitest whose probe leaves a registered root behind and expect the
//     run to fail.
//
// Poison values point at paths that do not exist and are never connected to: nothing here reaches a real core.

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = join(HERE, "..");
const POISON_DIR = "/nonexistent-hc-poison";
const POISON_ENV = {
  HC_SOCKET: `${POISON_DIR}/core.sock`,
  HC_SESSION: "ambient-poison",
  HC_SCOPE: "ambient-poison-scope",
  HC_TERMINAL_ID: "t-ambient-poison",
  HC_TERMINAL_SOCKET: `${POISON_DIR}/terminal.sock`,
  HC_FUTURE_SELECTOR: "ambient-poison",
  XDG_RUNTIME_DIR: `${POISON_DIR}/run`,
};

function childVitest(testNamePattern: string, extraEnv: Record<string, string>) {
  const vitestBin = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");
  return spawnSync(
    process.execPath,
    [vitestBin, "run", "test/hc-hermetic-harness.test.ts", "-t", testNamePattern],
    { cwd: DAEMON_ROOT, env: { ...process.env, ...extraEnv }, encoding: "utf8", timeout: 150_000 },
  );
}

describe("hc env hygiene (in process)", () => {
  it("no HC_-prefixed variable survives the setup", () => {
    expect(Object.keys(process.env).filter((k) => k.startsWith("HC_"))).toEqual([]);
  });

  it("XDG_RUNTIME_DIR is gone, so no socket can come from the host's runtime dir", () => {
    expect(process.env.XDG_RUNTIME_DIR).toBeUndefined();
  });

  it("a default HcClient would resolve to a socket inside the fixture user home, never a poison or host path", () => {
    const socket = resolveHcSocket(process.env);
    const fixtureUserHome = `${process.env.OPENRIG_HOME}-user-home`;
    expect(socket.startsWith(`${fixtureUserHome}/`)).toBe(true);
    expect(socket.startsWith(POISON_DIR)).toBe(false);
    expect(socket).toContain("/herdr-core/default/");
  });
});

describe("hc seat poison: the setup neutralises a seat's ambient core env", () => {
  it("a vitest started with HC_* and XDG_RUNTIME_DIR naming a core passes the hygiene rows", () => {
    const child = childVitest("hc env hygiene", POISON_ENV);
    const output = `${child.stdout}\n${child.stderr}`;
    expect(output).toMatch(/3 passed/);
    expect(child.status, output).toBe(0);
  }, 180_000);
});

describe("hc scratch tripwire: the run's registry (unit)", () => {
  const dirs: string[] = [];
  const fresh = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
  const registryEnv = (): { env: Record<string, string | undefined>; registry: string } => {
    const env: Record<string, string | undefined> = {};
    const registry = createHcScratchRegistry(env, fresh("tripwire-tmp-"));
    return { env, registry };
  };
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("a registered root that is still on disk is leaked, with the test that asked for it", () => {
    const { env, registry } = registryEnv();
    const root = join(fresh("tripwire-base-"), "hcs-abc123");
    mkdirSync(root);
    registerHcScratchRoot(root, "test/some-file.test.ts", env);
    expect(findLeakedHcScratch(registry)).toEqual([{ root, test: "test/some-file.test.ts" }]);
  });

  it("a registered root that cleanup removed is not leaked (positive control: its entry is in the registry)", () => {
    const { env, registry } = registryEnv();
    const root = join(fresh("tripwire-base-"), "hcs-abc123");
    mkdirSync(root);
    registerHcScratchRoot(root, undefined, env);
    expect(readdirSync(registry)).toEqual(["hcs-abc123"]);
    rmSync(root, { recursive: true, force: true });
    expect(findLeakedHcScratch(registry)).toEqual([]);
  });

  it("an hcs- directory nobody registered is not this run's, however fresh (a concurrent run's live root)", () => {
    const { env, registry } = registryEnv();
    const base = fresh("tripwire-base-");
    mkdirSync(join(base, "hcs-mine11"));
    mkdirSync(join(base, "hcs-theirs"));
    registerHcScratchRoot(join(base, "hcs-mine11"), undefined, env);
    expect(findLeakedHcScratch(registry).map((l) => l.root)).toEqual([join(base, "hcs-mine11")]);
  });

  it("registering without a registry is a no-op (a bare vitest of one file has no global setup)", () => {
    const base = fresh("tripwire-base-");
    mkdirSync(join(base, "hcs-abc123"));
    expect(() => registerHcScratchRoot(join(base, "hcs-abc123"), "x", {})).not.toThrow();
    expect(() => registerHcScratchRoot(join(base, "hcs-abc123"), "x", { [HC_SCRATCH_REGISTRY_ENV]: join(base, "no-such-registry") })).not.toThrow();
    expect(readdirSync(base)).toEqual(["hcs-abc123"]);
  });

  it("only the process that made the registry owns it", () => {
    const { env } = registryEnv();
    expect(ownsHcScratchRegistry(env)).toBe(true);
    expect(ownsHcScratchRegistry(env, process.pid + 1)).toBe(false);
    expect(ownsHcScratchRegistry({ ...env, [HC_SCRATCH_REGISTRY_OWNER_ENV]: String(process.pid + 1) })).toBe(false);
    expect(ownsHcScratchRegistry({})).toBe(false);
  });

  it("an entry that names no root throws: a registry that cannot be read must not report clean", () => {
    const { registry } = registryEnv();
    writeFileSync(join(registry, "hcs-bad000"), JSON.stringify({ test: "x" }));
    expect(() => findLeakedHcScratch(registry)).toThrow(/names no root/);
  });

  it("startHcScratch registers its root before anything can fail (hc absent: the start fails, the root is gone, the entry stays)", () => {
    const { env, registry } = registryEnv();
    const base = fresh("tripwire-base-");
    const saved = process.env[HC_SCRATCH_REGISTRY_ENV];
    process.env[HC_SCRATCH_REGISTRY_ENV] = env[HC_SCRATCH_REGISTRY_ENV];
    try {
      expect(() => startHcScratch({ baseDir: base, hcBin: "/bin/false", baseEnv: { PATH: process.env.PATH } })).toThrow(/exited/);
    } finally {
      if (saved === undefined) delete process.env[HC_SCRATCH_REGISTRY_ENV]; else process.env[HC_SCRATCH_REGISTRY_ENV] = saved;
    }
    const entries = readdirSync(registry);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^hcs-/);
    expect(readdirSync(base)).toEqual([]);
    expect(findLeakedHcScratch(registry)).toEqual([]);
  });

  // fixture-home-cleanup.test.ts calls teardown() inside a worker. The worker inherits the main process's registry
  // variables; it must neither read the registry (the run's other workers have live cores in it) nor remove it.
  it("teardown() in a process that does not own the registry leaves the registry and every root in it alone", () => {
    const { env, registry } = registryEnv();
    const root = join(fresh("tripwire-base-"), "hcs-live11");
    mkdirSync(root);
    registerHcScratchRoot(root, "other-worker.test.ts", env);
    const saved = { r: process.env[HC_SCRATCH_REGISTRY_ENV], o: process.env[HC_SCRATCH_REGISTRY_OWNER_ENV] };
    process.env[HC_SCRATCH_REGISTRY_ENV] = registry;
    process.env[HC_SCRATCH_REGISTRY_OWNER_ENV] = String(process.pid + 1);
    try {
      expect(() => globalTeardown()).not.toThrow();
      expect(existsSync(registry), "the owner's registry survived").toBe(true);
      expect(existsSync(root)).toBe(true);
      expect(process.env[HC_SCRATCH_REGISTRY_ENV]).toBe(registry);
    } finally {
      if (saved.r === undefined) delete process.env[HC_SCRATCH_REGISTRY_ENV]; else process.env[HC_SCRATCH_REGISTRY_ENV] = saved.r;
      if (saved.o === undefined) delete process.env[HC_SCRATCH_REGISTRY_OWNER_ENV]; else process.env[HC_SCRATCH_REGISTRY_OWNER_ENV] = saved.o;
    }
  });
});

// The probe: only active inside the child runs below. It makes (and optionally removes) a root the way hc-scratch names it, and
// registers it the way hc-scratch does, in the child run's own registry (the child's setup made it; the owner pid differs from ours).
const PROBE_BASE = process.env.OPENRIG_HC_TRIPWIRE_PROBE_BASE;
describe("hc tripwire probe (child run only)", () => {
  it.skipIf(!PROBE_BASE)("leaves a scratch root behind unless told to clean it", () => {
    const root = join(PROBE_BASE!, "hcs-probe1");
    mkdirSync(root);
    registerHcScratchRoot(root, "hc-hermetic-harness.test.ts probe");
    if (process.env.OPENRIG_HC_TRIPWIRE_PROBE_CLEANS === "1") rmSync(root, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});

describe("hc scratch tripwire: the run fails (real vitest)", () => {
  const run = (cleans: boolean) => {
    const base = mkdtempSync(join(tmpdir(), "tripwire-run-"));
    try {
      const child = childVitest("hc tripwire probe", {
        OPENRIG_HC_TRIPWIRE_PROBE_BASE: base,
        OPENRIG_HC_TRIPWIRE_PROBE_CLEANS: cleans ? "1" : "0",
      });
      return { child, output: `${child.stdout}\n${child.stderr}`, left: existsSync(join(base, "hcs-probe1")) };
    } finally { rmSync(base, { recursive: true, force: true }); }
  };

  it("a test file that leaves an hcs- root behind turns the run red and names the root", () => {
    const { child, output, left } = run(false);
    expect(left).toBe(true); // the probe really left it (positive control for the next two lines)
    expect(output).toContain("hcs-probe1");
    expect(output).toContain("left behind by this run");
    expect(child.status, output).not.toBe(0);
  }, 180_000);

  it("the same probe that cleans up after itself leaves the run green", () => {
    const { child, output, left } = run(true);
    expect(left).toBe(false);
    expect(output).toMatch(/1 passed/);
    expect(child.status, output).toBe(0);
  }, 180_000);
});
