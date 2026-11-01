import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHcSocket } from "../src/adapters/hc-client.js";
import { findLeakedHcScratch, sessionOfRoot, type ProcessTable } from "../../../test/hc-scratch-tripwire.js";

// hc cutover W8: the harness consumers of the hc cutover.
//
//  A. test/hermetic-env.setup.ts scrubs HC_* and XDG_RUNTIME_DIR. Inside a seat the env names the seat's own core, and a
//     default `new HcClient()` follows it (hc-client.ts resolveHcSocket: HC_SOCKET, then HC_SESSION under
//     XDG_RUNTIME_DIR, then the state dir). The hygiene rows assert what a test file sees AFTER the setup ran; the child
//     row proves the setup does it by running this file's hygiene rows in a vitest whose own env is poisoned.
//  B. test/hermetic-env.global.ts teardown fails the run when a private hc core root made by hc-scratch is left behind
//     (test/hc-scratch-tripwire.ts). The unit rows pin the attribution rules; the child rows run a real vitest whose
//     probe leaves a root behind and expect the run to fail.
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

describe("the real-Codex opt-in still scrubs the core's socket (security review F8)", () => {
  it("OPENRIG_E2E_REAL_CODEX=1 with HC_* and XDG_RUNTIME_DIR naming a core passes the same hygiene rows, with the real HOME kept", () => {
    const child = childVitest("hc env hygiene", { ...POISON_ENV, OPENRIG_E2E_REAL_CODEX: "1" });
    const output = `${child.stdout}\n${child.stderr}`;
    expect(output).toMatch(/3 passed/);
    expect(child.status, output).toBe(0);
  }, 180_000);
});

const processes = (argsText: string, parents: Array<[number, number]> = []): ProcessTable => ({ parents: new Map(parents), argsText });

describe("hc scratch tripwire: attribution (unit)", () => {
  const make = (names: string[]) => {
    const base = mkdtempSync(join(tmpdir(), "tripwire-unit-"));
    for (const n of names) mkdirSync(join(base, n));
    return base;
  };
  const MAIN = 1000;
  const input = (base: string, table: ProcessTable, aliveSet: number[]) => ({
    scanBase: base, runStartedMs: Date.now() - 60_000, mainPid: MAIN, processes: table, alive: (pid: number) => aliveSet.includes(pid),
  });

  it("a root made during the run, with no guard at all, is leaked", () => {
    const base = make(["hcs-abc123"]);
    try {
      expect(findLeakedHcScratch(input(base, processes(""), [])).leaked).toEqual([join(base, "hcs-abc123")]);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("directories that are not scratch roots are ignored (positive control: the same dir named hcs- is found)", () => {
    const base = make(["other-abc123", "hcs-zzz999", "hcs"]);
    try {
      expect(findLeakedHcScratch(input(base, processes(""), [])).leaked).toEqual([join(base, "hcs-zzz999")]);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("a root older than the run start is not this run's", () => {
    const base = make(["hcs-old111"]);
    try {
      // A run that started after the root was born is the same comparison as a root older than the run.
      const found = findLeakedHcScratch({ ...input(base, processes(""), []), runStartedMs: Date.now() + 60_000 });
      expect(found.leaked).toEqual([]);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("a root whose session is held by a live guard owned OUTSIDE this run's tree is foreign, not a leak", () => {
    const base = make(["hcs-abc123", "hcs-def456"]);
    try {
      const guard = `/bin/sh -c while kill -0 ... reaper:hc-scratch 4242 env HC_SESSION=sabc123`;
      const found = findLeakedHcScratch(input(base, processes(guard, [[4242, 1]]), [4242]));
      expect(found.foreign).toEqual([join(base, "hcs-abc123")]);
      expect(found.leaked).toEqual([join(base, "hcs-def456")]);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("a guard whose owner is a descendant of the main process is this run's: its root is a leak", () => {
    const base = make(["hcs-abc123"]);
    try {
      const guard = `reaper:hc-scratch 4242 env HC_SESSION=sabc123`;
      const found = findLeakedHcScratch(input(base, processes(guard, [[4242, 2000], [2000, MAIN]]), [4242]));
      expect(found.leaked).toEqual([join(base, "hcs-abc123")]);
      expect(found.foreign).toEqual([]);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("a guard whose owner is dead does not make its root foreign", () => {
    const base = make(["hcs-abc123"]);
    try {
      const guard = `reaper:hc-scratch 4242 env HC_SESSION=sabc123`;
      expect(findLeakedHcScratch(input(base, processes(guard, [[4242, 1]]), [])).leaked).toEqual([join(base, "hcs-abc123")]);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("a foreign live guard with no session in argv (off Linux) makes every candidate unattributed, never a leak", () => {
    const base = make(["hcs-abc123"]);
    try {
      const found = findLeakedHcScratch(input(base, processes("reaper:hc-scratch 4242 pid 77 x y", [[4242, 1]]), [4242]));
      expect(found.unattributed).toEqual([join(base, "hcs-abc123")]);
      expect(found.leaked).toEqual([]);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("a missing scan base reports nothing", () => {
    expect(findLeakedHcScratch(input(join(tmpdir(), "tripwire-no-such-dir"), processes(""), []))).toEqual({ leaked: [], unattributed: [], foreign: [] });
  });

  it("the session derived from a root name is the one hc-scratch derives", () => {
    expect(sessionOfRoot("hcs-AbC1_9")).toBe("sabc109"); // last six, lowercased, non-alphanumerics to 0, prefixed with s
  });
});

// The probe: only active inside the child runs below. It makes (and optionally removes) a root the way hc-scratch names it.
const PROBE_BASE = process.env.OPENRIG_HC_TRIPWIRE_PROBE_BASE;
describe("hc tripwire probe (child run only)", () => {
  it.skipIf(!PROBE_BASE)("leaves a scratch root behind unless told to clean it", () => {
    const root = join(PROBE_BASE!, "hcs-probe1");
    mkdirSync(root);
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
        OPENRIG_TEST_HC_SCAN_BASE: base,
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
