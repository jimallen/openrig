import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNoForeignHcCore, assertPrivateHcEnv, detectForeignHcCore, findHc, HcForeignCoreError, HcNotPrivateError,
  HcSocketTooLongError, HC_SOCKET_PATH_LIMIT, HC_SOCKET_PATH_RESERVE, hcCountedSocketBytes, hcScratchFallback, hcSocketFits, startHcScratch,
  type HcScratch,
} from "./helpers/hc-scratch.js";
import { resolveHcSocket } from "../src/adapters/hc-client.js";
import { canSweepEnviron, hasProcFs, identityOf, pidsWithEnv, sameProcess, waitGone } from "./helpers/orphan-reaper.js";

const HC = findHc();
const PATH = process.env.PATH ?? "";

const scratches: HcScratch[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of scratches.splice(0)) s.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** Direct children of `parent`. */
const childrenOf = (parent: number): number[] => spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).stdout.split("\n")
  .map((l) => l.trim().split(/\s+/).map(Number)).filter(([, ppid]) => ppid === parent).map(([pid]) => pid!);
/** A terminal program that ignores hangups (and so outlives its holder's death, as a nohup-style program does): `sleep`, with SIGHUP ignored. */
const HUP_IGNORING_PROGRAM = ["sh", "-c", "trap '' HUP; exec sleep 300"];
// Short on every host: a root under macOS's own tmpdir() (/var/folders/xx/<32 chars>/T/, 48 bytes; 56 once resolved to /private/var/...) leaves a socket hc refuses.
const tmpBase = (): string => { const d = mkdtempSync(join(hcScratchFallback(tmpdir()), "hcsb-")); dirs.push(d); return d; };
/** A program that exists and exits 1 on both platforms (macOS has no /bin/false). */
const FALSE = ["/usr/bin/false", "/bin/false"].find((p) => existsSync(p)) ?? "/usr/bin/false";
/** A folder whose path is exactly `bytes` long: `<short temp>/hcsb-xxxxxx/<padding>` (the short temp is /tmp where tmpdir() is long, as on macOS). */
const baseOfLength = (bytes: number): string => {
  const top = mkdtempSync(join(hcScratchFallback(tmpdir()), "hcsb-"));
  dirs.push(top);
  const base = join(top, "p".repeat(bytes - Buffer.byteLength(top) - 1));
  mkdirSync(base);
  expect(Buffer.byteLength(base)).toBe(bytes);
  return base;
};

// A private env that is valid under a root, for the refusal rows. Each row breaks exactly one thing.
const ROOT = "/run/hcs-fixture";
const valid = (): Record<string, string | undefined> => ({
  PATH, HOME: `${ROOT}/h`, HC_SESSION: "sfixture", XDG_CONFIG_HOME: `${ROOT}/c`, XDG_DATA_HOME: `${ROOT}/d`,
  XDG_STATE_HOME: `${ROOT}/s`, XDG_RUNTIME_DIR: `${ROOT}/r`,
});

describe("hc scratch refuses to reach a core it did not start (no hc needed)", () => {
  it("control: a fully private env passes", () => {
    expect(() => assertPrivateHcEnv(valid(), ROOT)).not.toThrow();
  });

  it("an ambient HC_SOCKET is a named refusal that creates nothing and starts nothing", () => {
    const base = tmpBase();
    expect(detectForeignHcCore({ HC_SOCKET: "/home/jim/.local/state/herdr-core/default/default.sock" })?.name).toBe("HC_SOCKET");
    expect(() => assertNoForeignHcCore({ HC_SOCKET: "/x/default.sock" })).toThrow(HcForeignCoreError);
    expect(() => startHcScratch({ baseDir: base, hcBin: "/bin/false", baseEnv: { PATH, HC_SOCKET: "/x/default.sock" } }))
      .toThrow(/HC_SOCKET=\/x\/default\.sock points at a core this helper did not start/);
    expect(readdirSync(base)).toEqual([]);
  });

  it("an exported-but-empty HC_SOCKET is absent, and the host's seat vars are no refusal (a test may run inside a seat)", () => {
    expect(detectForeignHcCore({ HC_SOCKET: "" })).toBeNull();
    expect(detectForeignHcCore({ HC_TERMINAL_ID: "t1", HC_TERMINAL_SOCKET: "/x", HC_SCOPE: "s", HC_SESSION: "default" })).toBeNull();
  });

  it.each([
    ["no HC_SESSION, which selects the default core", { HC_SESSION: undefined }, /HC_SESSION is empty/],
    ["an empty HC_SESSION", { HC_SESSION: "" }, /HC_SESSION is empty/],
    ["HC_SESSION=default", { HC_SESSION: "default" }, /HC_SESSION is `default`/],
    ["a HOME outside the root", { HOME: "/home/jim" }, /HOME is not inside/],
    ["a relative HOME", { HOME: "h" }, /HOME is not inside/],
    ["an XDG_RUNTIME_DIR outside the root", { XDG_RUNTIME_DIR: "/run/user/1000" }, /XDG_RUNTIME_DIR is not inside/],
    ["an XDG_STATE_HOME outside the root", { XDG_STATE_HOME: "/home/jim/.local/state" }, /XDG_STATE_HOME is not inside/],
    ["an XDG_CONFIG_HOME outside the root", { XDG_CONFIG_HOME: "/home/jim/.config" }, /XDG_CONFIG_HOME is not inside/],
    ["an XDG_DATA_HOME outside the root", { XDG_DATA_HOME: "/home/jim/.local/share" }, /XDG_DATA_HOME is not inside/],
    ["an HC_SOCKET outside the root", { HC_SOCKET: "/home/jim/.local/state/herdr-core/default/default.sock" }, /HC_SOCKET is set outside/],
    ["an HC_TERMINAL_SOCKET (a seat of another core)", { HC_TERMINAL_SOCKET: "/x/t.sock" }, /HC_TERMINAL_SOCKET is set/],
    ["an HC_TERMINAL_ID", { HC_TERMINAL_ID: "t1" }, /HC_TERMINAL_ID is set/],
    ["an HC_SCOPE", { HC_SCOPE: "s" }, /HC_SCOPE is set/],
  ] as const)("refuses %s, before any hc process", (_name, change, message) => {
    const env = { ...valid(), ...change };
    expect(() => assertPrivateHcEnv(env, ROOT)).toThrow(HcNotPrivateError);
    expect(() => assertPrivateHcEnv(env, ROOT)).toThrow(message);
  });

  it("an HC_SOCKET inside the root passes: it is the helper's own redirect", () => {
    expect(() => assertPrivateHcEnv({ ...valid(), HC_SOCKET: `${ROOT}/r/x.sock` }, ROOT)).not.toThrow();
  });

  it("a baseDir that would put the socket over the limit is refused before hc is asked, leaving nothing behind", () => {
    const base = tmpBase();
    const deep = join(base, "a".repeat(40), "b".repeat(40));
    mkdirSync(deep, { recursive: true });
    expect(() => startHcScratch({ baseDir: deep, hcBin: "/bin/false", baseEnv: { PATH } })).toThrow(HcSocketTooLongError);
    expect(readdirSync(deep)).toEqual([]);
  });

  it("the default layout is well inside the limit as hc counts it, with room to spare", () => {
    const socket = resolveHcSocket({ ...valid(), HOME: "/run/hcs-abc123/h", HC_SESSION: "sabc123", XDG_RUNTIME_DIR: "/run/hcs-abc123/r" });
    expect(socket).toBe("/run/hcs-abc123/r/herdr-core/sabc123.sock");
    expect(hcCountedSocketBytes(socket)).toBe(Buffer.byteLength(socket) + HC_SOCKET_PATH_RESERVE);
    expect(hcCountedSocketBytes(socket)).toBeLessThan(HC_SOCKET_PATH_LIMIT - 30);
  });

  // hc 0.1.19 (stu, 2026-11-13) refuses a session when its socket path plus 16 bytes is over 103 (helpers/hc-scratch.ts HC_SOCKET_PATH_RESERVE).
  // A scratch root is `<base>/hcs-xxxxxx` and its session 7 bytes, so its socket is `<base>`+37 and hc counts `<base>`+53: a 50-byte base is the
  // deepest hc starts, and a 51-byte one is hc's exit 2. The old guard measured the bare socket (and a state-dir layout hc does not use when the
  // runtime dir is set): it let a base through up to 58 bytes, and hc then refused the core itself.
  it("the guard refuses the first base hc would refuse (51 bytes), before anything is made, and passes the deepest one hc takes (50)", () => {
    const at51 = baseOfLength(51);
    try {
      startHcScratch({ baseDir: at51, hcBin: FALSE, baseEnv: { PATH } });
      expect.unreachable("a base whose socket hc refuses must be refused by the guard");
    } catch (error) {
      expect(error).toBeInstanceOf(HcSocketTooLongError);
      expect((error as HcSocketTooLongError).bytes).toBe(HC_SOCKET_PATH_LIMIT + 1);
      expect(Buffer.byteLength((error as HcSocketTooLongError).path), "the bare socket is under the limit: only hc's count is over it").toBe(88);
    }
    expect(readdirSync(at51)).toEqual([]);
    // At 50 the guard lets it through, and the stand-in for hc is what fails.
    expect(() => startHcScratch({ baseDir: baseOfLength(50), hcBin: FALSE, baseEnv: { PATH } })).toThrow(/`hc server start` exited 1/);
  });

  it("hcSocketFits is hc's rule at the edge: 87 bytes of socket fit, 88 do not", () => {
    expect(hcSocketFits(`/${"a".repeat(86)}`)).toBe(true);
    expect(hcSocketFits(`/${"a".repeat(87)}`)).toBe(false);
  });
});

describe("hc scratch asks the core to stop, against a recording stand-in for hc (no real core)", () => {
  it("cleanup reads the status, then runs `hc server stop`, then removes the root", () => {
    const base = tmpBase();
    const log = join(base, "calls.log");
    const fakeCore = spawn("sleep", ["600"], { stdio: "ignore", detached: true });
    const bin = join(base, "hc");
    writeFileSync(bin, [
      "#!/bin/sh",
      `echo "$HC_SESSION $*" >> ${log}`,
      'case "$1 $2" in',
      '  "server start") mkdir -p "$XDG_RUNTIME_DIR/herdr-core"; : > "$XDG_RUNTIME_DIR/herdr-core/$HC_SESSION.sock" ;;',
      `  "server status") echo '{"pid": ${fakeCore.pid}, "holders": []}' ;;`,
      `  "server stop") kill ${fakeCore.pid}; echo '{"stopped":true}' ;;`,
      "esac", "",
    ].join("\n"));
    chmodSync(bin, 0o755);
    try {
      const s = startHcScratch({ baseDir: base, hcBin: bin, baseEnv: { PATH } });
      expect(readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.split(" ").slice(1).join(" "))).toEqual(["server start", "server status --json"]);
      s.cleanup();
      expect(readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.split(" ").slice(1).join(" "))).toEqual([
        "server start", "server status --json", "server status --json", "server stop",
      ]);
      expect(existsSync(s.root)).toBe(false);
    } finally {
      try { if (fakeCore.pid !== undefined) process.kill(fakeCore.pid, "SIGKILL"); } catch { /* already stopped by the stand-in */ }
    }
  });
});

describe.skipIf(!HC)("hc scratch against a real private core", () => {
  it("the guard is never looser than hc: at the deepest base the guard passes, the real hc starts the core; on macOS hc refuses the next byte", () => {
    const s = startHcScratch({ baseDir: baseOfLength(50), baseEnv: { PATH } });
    scratches.push(s);
    expect(hcCountedSocketBytes(s.socketPath)).toBe(HC_SOCKET_PATH_LIMIT);
    expect(existsSync(s.socketPath)).toBe(true);
    s.cleanup();
    if (process.platform !== "darwin") return;  // Linux allows 107 (hc 0.1.15): there the guard is stricter than hc, which is the safe side
    // The env the guard refuses at 51, given to the real hc by hand: hc's own refusal, so the guard matches hc and is not merely stricter.
    const root = join(baseOfLength(51), "hcs-abcdef");
    const env = { PATH, HOME: `${root}/h`, HC_SESSION: "sabcdef", XDG_CONFIG_HOME: `${root}/c`, XDG_DATA_HOME: `${root}/d`, XDG_STATE_HOME: `${root}/s`, XDG_RUNTIME_DIR: `${root}/r` };
    for (const d of ["h", "c", "d", "s", "r"]) mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
    expect(assertPrivateHcEnv(env, root)).toBeUndefined();
    const out = spawnSync(HC!, ["server", "start"], { env, encoding: "utf8", timeout: 30_000 });
    if (out.status === 0) spawnSync(HC!, ["server", "stop"], { env, encoding: "utf8", timeout: 30_000 });
    expect(out.status, out.stdout + out.stderr).toBe(2);
    expect(out.stdout + out.stderr).toContain(`is too long here (${HC_SOCKET_PATH_LIMIT + 1} bytes; this system allows ${HC_SOCKET_PATH_LIMIT})`);
  });

  it("starts a core whose socket and env are inside the root, with nothing of the caller's copied", () => {
    const s = startHcScratch({ baseEnv: { PATH, DOCKER_HOST: "tcp://leak", HC_TERMINAL_ID: "t9", HC_SESSION: "default", TYPESAFE_API_KEY: "k" } });
    scratches.push(s);
    expect(s.socketPath.startsWith(`${s.root}/`)).toBe(true);
    expect(existsSync(s.socketPath)).toBe(true);
    expect(Object.keys(s.env).sort()).toEqual(["HC_SESSION", "HOME", "PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "XDG_STATE_HOME"]);
    const status = JSON.parse(s.run(["server", "status", "--json"]).stdout) as { pid: number };
    expect(typeof status.pid).toBe("number");
    expect(s.session).not.toBe("default");
  });

  it.skipIf(!hasProcFs())("the core process itself carries only the stated env (read from /proc)", () => {
    const s = startHcScratch({ baseEnv: { PATH, DOCKER_HOST: "tcp://leak", HC_TERMINAL_ID: "t9", TYPESAFE_API_KEY: "k" } });
    scratches.push(s);
    const pid = (JSON.parse(s.run(["server", "status", "--json"]).stdout) as { pid: number }).pid;
    const names = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((e) => e.split("=")[0]);
    expect(names).toContain("HC_SESSION");
    expect(names).not.toContain("DOCKER_HOST");
    expect(names).not.toContain("HC_TERMINAL_ID");
    expect(names).not.toContain("TYPESAFE_API_KEY");
  });

  it("cleanup stops the core and a terminal program, removes the root, and is idempotent", async () => {
    const s = startHcScratch();
    scratches.push(s);
    const started = JSON.parse(s.run(["run", "--bg", "--json", ...HUP_IGNORING_PROGRAM]).stdout) as { address: string };
    expect(started.address).toMatch(/^t\d+$/);
    s.refreshOrphanGuard();
    const status = JSON.parse(s.run(["server", "status", "--json"]).stdout) as { pid: number; holders: Array<{ pid: number }> };
    const program = status.holders.flatMap((h) => childrenOf(h.pid));
    expect(program.length, "positive control: the holder has a program under it").toBeGreaterThan(0);
    const pids = [status.pid, ...status.holders.map((h) => h.pid), ...program];
    expect(pids.length).toBeGreaterThanOrEqual(2);  // positive control: the core and a holder were found
    const ids = pids.map((p) => identityOf(p));
    expect(ids.every((i) => i !== null)).toBe(true);
    s.cleanup();
    expect(existsSync(s.root)).toBe(false);
    for (const id of ids) expect(id !== null && sameProcess(id)).toBe(false);
    if (canSweepEnviron()) expect(pidsWithEnv(`HC_SESSION=${s.session}`)).toEqual([]);
    expect(() => s.cleanup()).not.toThrow();
    scratches.pop();
  });

  it.skipIf(!canSweepEnviron())("cleanup disarms the orphan guard it armed (positive control: it is visible while armed)", () => {
    const watchdogs = (session: string): number => spawnSync("ps", ["-eo", "args="], { encoding: "utf8" }).stdout
      .split("\n").filter((l) => l.includes("reaper:hc-scratch") && l.includes(`HC_SESSION=${session}`)).length;
    const s = startHcScratch();
    scratches.push(s);
    expect(watchdogs(s.session)).toBe(1);
    s.cleanup();
    expect(watchdogs(s.session)).toBe(0);
    scratches.pop();
  });

  it("a killed owner does not leave a core or its terminal programs behind: the orphan guard stops them", async () => {
    const owner = spawn("sleep", ["600"], { stdio: "ignore", detached: true });
    const ownerPid = owner.pid;
    if (ownerPid === undefined) throw new Error("could not start the stand-in owner");
    const s = startHcScratch({ ownerPid });
    scratches.push(s);
    // A terminal started AFTER the guard was armed and never re-recorded: only the session sweep can know its holder.
    s.run(["run", "--bg", "--json", ...HUP_IGNORING_PROGRAM]);
    const status = JSON.parse(s.run(["server", "status", "--json"]).stdout) as { pid: number; holders: Array<{ pid: number }> };
    expect(status.holders.length).toBe(1);  // positive control: there is a holder to lose
    // The terminal's own program, a child of its holder: on macOS it shows no environment, so only its parent leads to it.
    const program = childrenOf(status.holders[0]!.pid).map((pid) => identityOf(pid)).filter((id) => id !== null);
    expect(program.length, "positive control: the holder has a program under it").toBeGreaterThan(0);
    const targets = [status.pid, ...status.holders.map((h) => h.pid), ...program.map((id) => id.pid)].map((pid) => identityOf(pid));
    expect(targets.every((t) => t !== null && sameProcess(t))).toBe(true);
    process.kill(ownerPid, "SIGKILL");
    await waitGone(ownerPid, 5_000);
    // The watchdog polls once a second, TERMs, waits 3 s, then KILLs.
    const until = Date.now() + 15_000;
    while (targets.some((t) => t !== null && sameProcess(t)) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    expect(targets.map((t) => t !== null && sameProcess(t))).toEqual(targets.map(() => false));
    s.cleanup();  // a dead core: no hc call may restart it, and the root still goes
    expect(existsSync(s.root)).toBe(false);
    scratches.pop();
  }, 40_000);
});

describe("pidsWithEnv finds a session's processes", () => {
  it.skipIf(!canSweepEnviron())("by their environment and not their arguments; on macOS also the descendants of one (a protected program shows no environment)", async () => {
    const session = `sunit${process.pid}`;
    const entry = `HC_SESSION=${session}`;
    // The carrier is an unprotected program with the entry in its environment; its child runs with no environment at all.
    const carrier = spawn(process.execPath, ["-e", "require('child_process').spawn('env',['-i','sleep','300'],{stdio:'ignore'}); setTimeout(()=>{},300000)"],
      { env: { PATH: process.env.PATH, HC_SESSION: session }, stdio: "ignore" });
    // The decoy names the entry only in its argument list, as a watchdog does.
    const decoy = spawn(process.execPath, ["-e", "setTimeout(()=>{},300000)", entry], { env: { PATH: process.env.PATH }, stdio: "ignore" });
    const mine: number[] = [];
    try {
      const carrierPid = carrier.pid!;
      const found = await (async () => {
        const until = Date.now() + 10_000;
        for (;;) {
          const pids = pidsWithEnv(entry);
          if (pids.includes(carrierPid) && childrenOf(carrierPid).length > 0 || Date.now() > until) return pids;
          await new Promise((r) => setTimeout(r, 100));
        }
      })();
      const grandchildren = childrenOf(carrierPid);
      mine.push(...grandchildren);
      expect(grandchildren.length, "positive control: the carrier has a child without the entry").toBeGreaterThan(0);
      expect(found, "the process that carries the entry").toContain(carrierPid);
      expect(found, "a process that only names the entry in its arguments is not a holder").not.toContain(decoy.pid!);
      for (const child of grandchildren) {
        expect(found.includes(child), `child ${child}: swept as a descendant on macOS only, since /proc shows its (empty) environment on Linux`).toBe(process.platform === "darwin");
      }
    } finally {
      for (const pid of [...mine, carrier.pid!, decoy.pid!]) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
  });
});
