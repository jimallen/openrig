// Isolation of the test harness (hc cutover, W34). A contained run (one that sets OPENRIG_TEST_SCRATCH_ROOT and a run HOME) must
// find every private core, every scaffold and every account lookup inside its own root. These rows pin that consequence: a core
// made outside the run root, or a scaffold in the account's real home, is a machine-level leak the end-of-run tripwire cannot see.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHcSocket } from "../src/adapters/hc-client.js";
import { HC_SCRATCH_ROOT_ENV, HC_SOCKET_PATH_LIMIT, HcSocketTooLongError, hcScratchBase, startHcScratch } from "./helpers/hc-scratch.js";
import { PrivateCore as RootPrivateCore } from "./hc-private-core.js";
import { PrivateCore as HelperPrivateCore } from "./helpers/hc-private-core.js";
import { TRUSTED_BASE_ENV, TrustedBaseRefusedError, trustedBaseFolder } from "./helpers/trusted-scaffold.js";

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
  const shortBase = () => mkdtempSync(join(tmpdir(), "iso-"));

  it("both PrivateCore classes make their root under the run's scratch root", () => {
    const base = shortBase();
    try {
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

  it("an uncontained run whose HOME is a temp fixture keeps asking the account, as before", () => {
    expect(trustedBaseFolder({ HOME: "/tmp/fixture-home" }, () => "/home/account")).toBe("/home/account");
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
      ["packages/daemon/test/helpers/hc-scratch.ts", /mkdtempSync\(join\(options\.baseDir \?\? hcScratchBase\(baseEnv\), "hcs-"\)\)/],
      ["packages/daemon/test/helpers/hc-private-core.ts", /mkdtempSync\(join\(hcScratchBase\(process\.env, tmpdir\(\)\), "hcp-"\)\)/],
      ["packages/daemon/test/hc-private-core.ts", /mkdtempSync\(join\(hcScratchBase\(process\.env, tmpdir\(\)\), `hc-\$\{tag\}-`\)\)/],
    ];
    for (const [f, line] of makers) expect(text(join(repoRoot, f)), f).toMatch(line);
  });
});

describe("the default core's socket path in a test worker fits the platform limit", () => {
  it("is addressable (a probe of a core that is not running finds no core, not 'connect EINVAL')", () => {
    // macOS's own os.tmpdir() (/var/folders/xx/<32 chars>/T) put the fixture home's socket at 139 bytes; a path over the limit
    // makes every preflight that probes the default core report hc unhealthy (context add, setup, start, up auto-start).
    const socket = resolveHcSocket();
    expect(Buffer.byteLength(socket), socket).toBeLessThanOrEqual(HC_SOCKET_PATH_LIMIT);
    expect(socket.startsWith(`${realpathSync(tmpdir())}/`), "inside the worker's temp folder, never the account's state dir").toBe(true);
    expect(existsSync(socket), "no core is running at it").toBe(false);
  });
});
