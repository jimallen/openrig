// Isolation of the test harness (hc cutover, W34). A contained run (one that sets OPENRIG_TEST_SCRATCH_ROOT and a run HOME) must
// find every private core, every scaffold and every account lookup inside its own root. These rows pin that consequence: a core
// made outside the run root, or a scaffold in the account's real home, is a machine-level leak the end-of-run tripwire cannot see.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHcSocket } from "../src/adapters/hc-client.js";
import { HC_SCRATCH_ROOT_ENV, HC_SOCKET_PATH_LIMIT, HcSocketTooLongError, hcScratchBase, hcScratchFallback, startHcScratch } from "./helpers/hc-scratch.js";
import { HC_SCRATCH_REGISTRY_ENV, registerHcScratchRoot } from "../../../test/hc-scratch-tripwire.js";
import { PrivateCore as RootPrivateCore } from "./hc-private-core.js";
import { PrivateCore as HelperPrivateCore } from "./helpers/hc-private-core.js";
import { TRUSTED_BASE_ENV, TRUSTED_RUN_ROOT_PREFIX, TrustedBaseRefusedError, removeTrustedRunRoots, sweepAbandonedRunRoots, trustedBaseFolder } from "./helpers/trusted-scaffold.js";
import { realPathOf } from "./helpers/real-path-of.js";

const repoRoot = resolve(import.meta.dirname, "../../..");

describe("where a scratch core is made", () => {
  it("follows OPENRIG_TEST_SCRATCH_ROOT when a run sets it, and is /tmp when it does not", () => {
    expect(hcScratchBase({ [HC_SCRATCH_ROOT_ENV]: "/run/root/scr" })).toBe("/run/root/scr");
    expect(hcScratchBase({})).toBe("/tmp");
    expect(hcScratchBase({ [HC_SCRATCH_ROOT_ENV]: "" })).toBe("/tmp");
    expect(hcScratchBase({ [HC_SCRATCH_ROOT_ENV]: "relative/dir" })).toBe("/tmp");
    expect(hcScratchBase({}, "/var/tmp")).toBe("/var/tmp");
  });

  it("startHcScratch makes its root under the run's scratch root, and measures the socket there (a too-deep run root is refused, not shortened)", () => {
    const base = join(mkdtempSync(join(tmpdir(), "iso-")), "x".repeat(HC_SOCKET_PATH_LIMIT));
    mkdirSync(base, { recursive: true });
    try {
      startHcScratch({ baseEnv: { PATH: process.env.PATH, [HC_SCRATCH_ROOT_ENV]: base }, hcBin: ["/usr/bin/false", "/bin/false"].find((p) => existsSync(p)) ?? "/usr/bin/false" });
      expect.unreachable("a root too deep for a socket must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(HcSocketTooLongError);
      expect((error as HcSocketTooLongError).path.startsWith(`${base}/hcs-`)).toBe(true);
    } finally {
      rmSync(dirname(base), { recursive: true, force: true });
    }
  });
});

describe("where the other private cores are made, and their socket limit", () => {
  const withScratchRoot = <T>(base: string, run: () => T): T => {
    const saved = process.env[HC_SCRATCH_ROOT_ENV];
    process.env[HC_SCRATCH_ROOT_ENV] = base;
    try { return run(); } finally { if (saved === undefined) delete process.env[HC_SCRATCH_ROOT_ENV]; else process.env[HC_SCRATCH_ROOT_ENV] = saved; }
  };
  // Short on every host: this base carries a private core's root, sockets and holders, and macOS's own tmpdir() (/var/folders/xx/<32 chars>/T,
  // 56 bytes once resolved) leaves a core's socket 108 bytes. The row below that needs a TOO-deep root builds it on top of this base.
  // The base is put on the run's hc scratch list (test/hc-scratch-tripwire.ts) as soon as it exists: the PrivateCore roots made in it are not on
  // that list (only startHcScratch registers), and in /tmp nothing else would ever remove them, so a row that dies before its `finally` leaves a
  // base the end-of-run tripwire names, instead of a quiet folder in /tmp.
  const shortBase = () => {
    const base = mkdtempSync(join(hcScratchFallback(tmpdir()), "iso-"));
    registerHcScratchRoot(base, import.meta.filename);
    return base;
  };
  /** The run's registry entry for `base`, or null when this run has no registry (a vitest without the suite's global setup). */
  const registered = (base: string): string | null => {
    const registry = process.env[HC_SCRATCH_REGISTRY_ENV];
    if (!registry) return null;
    const entry = join(registry, basename(base));
    return existsSync(entry) ? (JSON.parse(readFileSync(entry, "utf8")) as { root: string }).root : "missing";
  };

  it("both PrivateCore classes make their root under the run's scratch root", () => {
    const base = shortBase();
    try {
      expect(registered(base), "the base holding the PrivateCore roots is on the run's tripwire list").toBe(process.env[HC_SCRATCH_REGISTRY_ENV] ? base : null);
      const a = withScratchRoot(base, () => new RootPrivateCore("iso"));
      const b = withScratchRoot(base, () => new HelperPrivateCore());
      expect(a.root.startsWith(`${base}/`)).toBe(true);
      expect(realpathSync(b.root).startsWith(`${realpathSync(base)}/`)).toBe(true);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("a run root too deep for the core's socket is refused by both, before any hc is started", () => {
    const base = join(shortBase(), "d".repeat(HC_SOCKET_PATH_LIMIT));
    mkdirSync(base, { recursive: true });
    try {
      expect(registered(dirname(base))).toBe(process.env[HC_SCRATCH_REGISTRY_ENV] ? dirname(base) : null);
      expect(() => withScratchRoot(base, () => new RootPrivateCore("iso"))).toThrow(/socket path would be \d+ bytes/);
      const b = withScratchRoot(base, () => new HelperPrivateCore());
      expect(() => b.start()).toThrow(/socket path would be \d+ bytes/);
    } finally { rmSync(dirname(base), { recursive: true, force: true }); }
  });
});

describe("where a trusted scaffold is made", () => {
  const account = () => { throw new Error("the account's real home was asked"); };

  it("uses the run's named trusted base, then its HOME outside temp, and never the account home in a contained run", () => {
    expect(trustedBaseFolder({ [TRUSTED_BASE_ENV]: "/usr", HOME: "/home/run" }, account)).toBe("/usr");
    expect(trustedBaseFolder({ HOME: "/home/run" }, account)).toBe("/home/run");
    expect(() => trustedBaseFolder({ HOME: "/private/tmp/orr.x/h", [HC_SCRATCH_ROOT_ENV]: "/private/tmp/orr.x/scr" }, account)).toThrow(TrustedBaseRefusedError);
    // A folder that exists and is a temp location on every platform (this process's own temp dir): the refusal must be for being temp.
    expect(() => trustedBaseFolder({ [TRUSTED_BASE_ENV]: tmpdir(), HOME: "/home/run" }, account)).toThrow(/is inside a temp location/);
    expect(() => trustedBaseFolder({ [TRUSTED_BASE_ENV]: "/no/such/folder", HOME: "/home/run" }, account)).toThrow(/not an existing absolute folder/);
  });

  // The production trust check refuses every temp location, so a run that names no base and whose HOME is a temp fixture has to put its
  // scaffolds outside temp. They used to be made straight in the account's real home (~/.of103-e2e-XXXXXX, ~/.of102-e2e-XXXXXX): a
  // test run left them there. The default is now ONE run root, made on first use and removed when the process exits, holding every scaffold.
  const withFakeAccount = (run: (home: string, exitHooks: Array<() => void>) => void) => {
    // Outside every temp location (the run root refuses a temp account home), and not the real home: beside this file.
    const home = realpathSync(mkdtempSync(join(import.meta.dirname, ".iso-acct-")));
    const hooks: Array<() => void> = [];
    try { run(home, hooks); } finally { rmSync(home, { recursive: true, force: true }); }
  };

  it("an uncontained run whose HOME is a temp fixture gets one contained run root under the account home, not the account home itself", () => {
    withFakeAccount((home, hooks) => {
      const base = trustedBaseFolder({ HOME: "/tmp/fixture-home" }, () => home, (cleanup) => { hooks.push(cleanup); });
      expect(base).not.toBe(home);
      expect(dirname(base)).toBe(home);
      expect(basename(base).startsWith(TRUSTED_RUN_ROOT_PREFIX)).toBe(true);
      expect(statSync(base).mode & 0o077).toBe(0);
      expect(readdirSync(home)).toEqual([basename(base)]);
      // One root per run: a second scaffold reuses it, and only one removal is registered.
      expect(trustedBaseFolder({ HOME: "/tmp/fixture-home" }, () => home, (cleanup) => { hooks.push(cleanup); })).toBe(base);
      expect(hooks).toHaveLength(1);
    });
  });

  it("the default run root, and every scaffold inside it, is removed when the process exits; nothing is left in the account home", () => {
    withFakeAccount((home, hooks) => {
      const base = trustedBaseFolder({ HOME: "/tmp/fixture-home" }, () => home, (cleanup) => { hooks.push(cleanup); });
      mkdirSync(join(base, ".of103-e2e-AbCdEf"), { recursive: true });
      expect(hooks).toHaveLength(1);
      const [cleanup] = hooks;
      if (!cleanup) throw new Error("no removal was registered");
      cleanup();
      expect(existsSync(base)).toBe(false);
      expect(readdirSync(home)).toEqual([]);
    });
  });

  // OF-225(a). The 'exit' hook above is only the fallback: measured on Sparky (vitest 3.2.4, one passing test that made a root), a vitest
  // worker ends with no 'exit' event in both the forks and the threads pool, so every run left an empty root in the account's real home
  // (123 of them). Production consequence if this regresses: every suite run leaves one more `~/.openrig-test-run-*` in the real home.
  it("removeTrustedRunRoots removes the run root and the scaffolds in it without any process exit, and the root is made again on next use", () => {
    withFakeAccount((home, hooks) => {
      const base = trustedBaseFolder({ HOME: "/tmp/fixture-home" }, () => home, (cleanup) => { hooks.push(cleanup); });
      mkdirSync(join(base, ".of103-e2e-AbCdEf", "home"), { recursive: true });
      writeFileSync(join(base, ".of103-e2e-AbCdEf", "home", "left-behind"), "x");
      removeTrustedRunRoots();
      expect(existsSync(base)).toBe(false);
      expect(readdirSync(home)).toEqual([]);
      removeTrustedRunRoots(); // twice is fine
      const again = trustedBaseFolder({ HOME: "/tmp/fixture-home" }, () => home, (cleanup) => { hooks.push(cleanup); });
      expect(existsSync(again)).toBe(true);
      removeTrustedRunRoots();
      expect(readdirSync(home)).toEqual([]);
    });
  });

  it("the daemon suite's setup removes the run roots in an afterAll (the per-file end of a vitest worker), and the config loads that setup", () => {
    const setup = readFileSync(join(import.meta.dirname, "helpers", "trusted-run-root.setup.ts"), "utf8");
    expect(setup).toMatch(/afterAll\(\(\) => \{ removeTrustedRunRoots\(\); \}\);/);
    expect(readFileSync(join(import.meta.dirname, "..", "vitest.config.ts"), "utf8")).toMatch(/setupFiles: \[[^\]]*"\.\/test\/helpers\/trusted-run-root\.setup\.ts"/);
  });

  // The suite-wide setup file runs before every test file's `vi.mock`. Anything it imports is loaded unmocked and cached, so a test file
  // that mocks `node:fs` and then imports a helper the setup already pulled in gets the REAL module back (release 53: the setup's
  // import of trusted-scaffold.ts reached hermetic-env.js, and hermetic-env-setup-failure.test.ts saw "expected [Function] to throw").
  it("the setup file reaches only node builtins and vitest: its one local import is the leaf trusted-run-root.ts, which imports no local module", () => {
    const importsOf = (f: string) => [...readFileSync(join(import.meta.dirname, "helpers", f), "utf8").matchAll(/^import [^;]*? from "([^"]+)";/gm)].map((m) => m[1] ?? "");
    expect(importsOf("trusted-run-root.setup.ts")).toEqual(["vitest", "./trusted-run-root.js"]);
    const leaf = importsOf("trusted-run-root.ts");
    expect(leaf.length, "positive control: the leaf's imports were read").toBeGreaterThan(0);
    expect(leaf.filter((m) => !m.startsWith("node:"))).toEqual([]);
  });

  it("a run root's name carries its creating pid, `<prefix><pid>-XXXXXX`", () => {
    withFakeAccount((home, hooks) => {
      const base = trustedBaseFolder({ HOME: "/tmp/fixture-home" }, () => home, (cleanup) => { hooks.push(cleanup); });
      expect(basename(base)).toMatch(new RegExp(`^${TRUSTED_RUN_ROOT_PREFIX.replace(".", "\\.")}${process.pid}-[A-Za-z0-9]{6}$`));
      removeTrustedRunRoots();
    });
  });

  // A SIGKILLed run cannot remove its root. The sweep must remove only what is provably abandoned: exact name, real directory, EMPTY,
  // creator's pid not alive. Each row below is one way a folder could be wrongly removed.
  describe("sweepAbandonedRunRoots removes only an empty, exactly-named root whose creating process is gone", () => {
    const P = TRUSTED_RUN_ROOT_PREFIX;
    const DEAD = 4000001;
    const LIVE = 4000002;
    const alive = (pid: number) => pid === LIVE;

    it("sweeps the dead, empty, exact one and keeps every look-alike", () => {
      withFakeAccount((home) => {
        const mk = (name: string, inside?: string) => { mkdirSync(join(home, name)); if (inside) writeFileSync(join(home, name, inside), "x"); };
        mk(`${P}${DEAD}-AbCdEf`);                     // swept
        mk(`${P}${LIVE}-AbCdEf`);                     // creator alive: kept
        mk(`${P}${DEAD}-GhIjKl`, "a-scaffold-file");  // non-empty: kept (rmdir refuses)
        mk(`${P}AbCdEf`);                             // the pre-pid name (123 on Sparky): never matched
        mk(`${P}${DEAD}-AbCdE`);                      // five characters: kept
        mk(`${P}${DEAD}-AbCdEfg`);                    // seven characters: kept
        mk(`${P}${DEAD}-AbC-Ef`);                     // not mkdtemp characters: kept
        mk(`x${P}${DEAD}-AbCdEf`);                    // not the exact prefix: kept
        mk(`${P}${DEAD}-AbCdEf.bak`);                 // suffix: kept
        mk(`${P.slice(0, -1)}${DEAD}-AbCdEf`);        // prefix without its last dash: kept
        mk(`${P}${process.pid}-AbCdEf`);              // this process's own: kept
        writeFileSync(join(home, `${P}${DEAD}-FileXY`), "");                          // a file, not a directory: kept
        mkdirSync(join(home, "target"));
        symlinkSync(join(home, "target"), join(home, `${P}${DEAD}-LinkXY`));          // a link to an empty folder: kept, target kept
        const before = readdirSync(home).sort();
        expect(sweepAbandonedRunRoots(home, alive)).toEqual([`${P}${DEAD}-AbCdEf`]);
        expect(readdirSync(home).sort()).toEqual(before.filter((n) => n !== `${P}${DEAD}-AbCdEf`));
        expect(existsSync(join(home, "target"))).toBe(true);
        expect(existsSync(join(home, `${P}${DEAD}-GhIjKl`, "a-scaffold-file"))).toBe(true);
      });
    });

    it("making a run root sweeps the abandoned one (a real dead pid) and keeps the one of a live process (this test's parent)", () => {
      withFakeAccount((home, hooks) => {
        const child = spawnSync(process.execPath, ["-e", ""]);
        expect(child.pid).toBeGreaterThan(0);
        const dead = `${P}${child.pid}-AbCdEf`;
        const live = `${P}${process.ppid}-AbCdEf`;
        mkdirSync(join(home, dead));
        mkdirSync(join(home, live));
        const base = trustedBaseFolder({ HOME: "/tmp/fixture-home" }, () => home, (cleanup) => { hooks.push(cleanup); });
        expect(readdirSync(home).sort()).toEqual([live, basename(base)].sort());
        removeTrustedRunRoots();
      });
    });
  });

  it("the default run root is outside every temp location, which the production trust check requires", () => {
    // The location is the account's to decide; an account home inside temp is refused, and nothing is made there.
    expect(() => trustedBaseFolder({ HOME: "/tmp/fixture-home" }, () => tmpdir(), () => undefined)).toThrow(TrustedBaseRefusedError);
  });
});

describe("census: no test reaches the account's real home or a hard-coded scratch root (instrument: a text scan of every .ts under packages/*/test and test/)", () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === "node_modules" ? [] : e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
  const dirs = [join(repoRoot, "test"), ...readdirSync(join(repoRoot, "packages")).map((p) => join(repoRoot, "packages", p, "test"))].filter((d) => existsSync(d) && statSync(d).isDirectory());
  const files = dirs.flatMap(walk);
  const rel = (f: string) => relative(repoRoot, f);
  const self = rel(import.meta.filename);
  const text = (f: string) => readFileSync(f, "utf8");
  // Built from parts so this file does not match its own scan.
  const USER_INFO = new RegExp(["user", "Info"].join("") + "\\s*\\(");
  const HARD_SCRATCH = new RegExp(["/tmp", "/hcs"].join(""));

  it("positive control: the scan saw the test trees", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.filter((f) => f.endsWith(".test.ts")).length).toBeGreaterThan(150);
    expect(files.map(rel)).toContain("packages/daemon/test/helpers/hc-scratch.ts");
  });

  it("no test file (*.test.ts) calls userInfo(); the one helper that asks the account is trusted-scaffold.ts", () => {
    const tests = files.filter((f) => /\.test\.[cm]?ts$/.test(f) && rel(f) !== self);
    expect(tests.filter((f) => USER_INFO.test(text(f))).map(rel)).toEqual([]);
    expect(files.filter((f) => !/\.test\.[cm]?ts$/.test(f) && USER_INFO.test(text(f))).map(rel)).toEqual(["packages/daemon/test/helpers/trusted-scaffold.ts"]);
  });

  it("no file but the scratch helper hard-codes the temp-folder hcs scratch root", () => {
    expect(files.filter((f) => rel(f) !== self && HARD_SCRATCH.test(text(f))).map(rel)).toEqual(["packages/daemon/test/helpers/hc-scratch.ts"]);
  });

  it("every private-core maker takes its base from hcScratchBase, at the line that makes the folder", () => {
    const makers: Array<[string, RegExp]> = [
      ["packages/daemon/test/helpers/hc-scratch.ts", /mkdtempSync\(join\(options\.baseDir \?\? hcScratchBase\(scratchRootEnv\(baseEnv\)\), "hcs-"\)\)/],
      ["packages/daemon/test/helpers/hc-private-core.ts", /mkdtempSync\(join\(hcScratchBase\(process\.env, hcScratchFallback\(tmpdir\(\)\)\), "hcp-"\)\)/],
      ["packages/daemon/test/hc-placement.real.test.ts", /mkdtempSync\(join\(hcScratchBase\(process\.env, hcScratchFallback\(tmpdir\(\)\)\), "hcp-"\)\)/],
      ["packages/daemon/test/hc-private-core.ts", /mkdtempSync\(join\(hcScratchBase\(process\.env, hcScratchFallback\(tmpdir\(\)\)\), `hc-\$\{tag\}-`\)\)/],
    ];
    for (const [f, line] of makers) expect(text(join(repoRoot, f)), f).toMatch(line);
  });

  // Census (instrument: a text scan of every .ts under the test trees). A folder made straight in the account's real home is a machine-level
  // leak a contained run cannot see. The account's home is asked in one place (trusted-scaffold.ts), and there only to place the run root.
  it("no file makes a folder directly in the account home, and trusted-scaffold.ts never returns the account home itself", () => {
    const IN_ACCOUNT_HOME = /mkdtempSync\(\s*(?:join\(\s*)?(?:homedir\(\)|userInfo\(\)\.homedir|accountHome\(\)|process\.env\.HOME\b)/;
    expect(files.filter((f) => rel(f) !== self && IN_ACCOUNT_HOME.test(text(f))).map(rel)).toEqual([]);
    const scaffold = text(join(repoRoot, "packages/daemon/test/helpers/trusted-scaffold.ts"));
    expect(scaffold).not.toMatch(/return\s+accountHome\(\)/);
    expect(scaffold.match(/accountHome\(\)/g) ?? []).toHaveLength(1);
    expect(scaffold).toMatch(/const home = accountHome\(\);[\s\S]*mkdtempSync\(join\(home, `\$\{TRUSTED_RUN_ROOT_PREFIX\}\$\{process\.pid\}-`\)\)/);
    // Positive control: the scan reached the file that makes the run root.
    expect(files.map(rel)).toContain("packages/daemon/test/helpers/trusted-scaffold.ts");
  });

  // Census (instrument: a text scan of every .ts under the test trees for a mkdtempSync whose name argument starts a private-core root).
  // MacOS run at 99a9f7d6 left /tmp/hcs-UQxEVs and /tmp/hcs-6iSiOM: the hermetic scaffold's startHcCore passed its caller's narrow baseEnv
  // (PATH, TERM, SHELL: no OPENRIG_TEST_SCRATCH_ROOT) to startHcScratch, which read the root from that env and fell back to /tmp.
  it("no file but the four makers makes a private-core root, and no caller of startHcScratch names a base folder of its own outside tests", () => {
    const MAKES_ROOT = /mkdtempSync\(.{0,120}?(?:"(?:hcs|hcp)-"|`hc-\$\{)/;
    const makers = files.filter((f) => rel(f) !== self && MAKES_ROOT.test(text(f))).map(rel).sort();
    expect(makers).toEqual(["packages/daemon/test/hc-placement.real.test.ts", "packages/daemon/test/hc-private-core.ts", "packages/daemon/test/helpers/hc-private-core.ts", "packages/daemon/test/helpers/hc-scratch.ts"]);
    const helperCallers = files.filter((f) => !/\.test\.[cm]?ts$/.test(f) && rel(f) !== self && /startHcScratch\(/.test(text(f)) && !/export function startHcScratch/.test(text(f)));
    expect(helperCallers.map(rel)).toEqual(["packages/daemon/test/helpers/hermetic-env.ts"]);
    for (const f of helperCallers) expect(text(f), rel(f)).not.toMatch(/startHcScratch\([^)]*baseDir/);
  });

  it("a caller whose baseEnv does not carry the variable still lands under the run's root (the scaffold's startHcCore did not)", () => {
    const base = join(mkdtempSync(join(tmpdir(), "iso-")), "x".repeat(HC_SOCKET_PATH_LIMIT));
    mkdirSync(base, { recursive: true });
    const saved = process.env[HC_SCRATCH_ROOT_ENV];
    process.env[HC_SCRATCH_ROOT_ENV] = base;
    try {
      startHcScratch({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color", SHELL: "/bin/bash" }, hcBin: ["/usr/bin/false", "/bin/false"].find((p) => existsSync(p)) ?? "/usr/bin/false" });
      expect.unreachable("a root too deep for a socket must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(HcSocketTooLongError);
      expect((error as HcSocketTooLongError).path.startsWith(`${base}/hcs-`)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env[HC_SCRATCH_ROOT_ENV]; else process.env[HC_SCRATCH_ROOT_ENV] = saved;
      rmSync(dirname(base), { recursive: true, force: true });
    }
  });
});

describe("the default core's socket path in a test worker fits the platform limit", () => {
  it("is addressable (a probe of a core that is not running finds no core, not 'connect EINVAL')", () => {
    // macOS's own os.tmpdir() (/var/folders/xx/<32 chars>/T) put the fixture home's socket at 139 bytes; a path over the limit
    // makes every preflight that probes the default core report hc unhealthy (context add, setup, start, up auto-start).
    const socket = resolveHcSocket();
    expect(Buffer.byteLength(socket), socket).toBeLessThanOrEqual(HC_SOCKET_PATH_LIMIT);
    // Both sides resolved: the setup makes the socket's parent under one spelling of the temp folder (/var/folders/...) and TMPDIR names the other (/private/var/folders/...).
    expect(realPathOf(socket).startsWith(`${realPathOf(tmpdir())}/`), "inside the worker's temp folder, never the account's state dir").toBe(true);
    expect(existsSync(socket), "no core is running at it").toBe(false);
  });
});
