import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNoForeignHcCore, assertPrivateHcEnv, detectForeignHcCore, findHc, HcForeignCoreError, HcNotPrivateError,
  HcSocketTooLongError, HC_SOCKET_PATH_LIMIT, longestSocketPath, startHcScratch, type HcScratch,
} from "./helpers/hc-scratch.js";
import { canSweepEnviron, hasProcFs, identityOf, pidsWithEnv, sameProcess, waitGone } from "./helpers/orphan-reaper.js";

const HC = findHc();
const PATH = process.env.PATH ?? "";

const scratches: HcScratch[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of scratches.splice(0)) s.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmpBase = (): string => { const d = mkdtempSync(join(tmpdir(), "hcsb-")); dirs.push(d); return d; };

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

  it("the default layout is well inside the limit on both platform layouts, with room to spare", () => {
    const longest = longestSocketPath("/run/hcs-abc123", "sabc123");
    expect(Buffer.byteLength(longest)).toBeLessThan(HC_SOCKET_PATH_LIMIT - 30);
    expect(longest).toBe("/run/hcs-abc123/s/herdr-core/sabc123/sabc123.sock");
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
    const started = JSON.parse(s.run(["run", "--bg", "--json", "sleep", "300"]).stdout) as { address: string };
    expect(started.address).toMatch(/^t\d+$/);
    s.refreshOrphanGuard();
    const status = JSON.parse(s.run(["server", "status", "--json"]).stdout) as { pid: number; holders: Array<{ pid: number }> };
    const pids = [status.pid, ...status.holders.map((h) => h.pid)];
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
    s.run(["run", "--bg", "--json", "sleep", "300"]);
    const status = JSON.parse(s.run(["server", "status", "--json"]).stdout) as { pid: number; holders: Array<{ pid: number }> };
    expect(status.holders.length).toBe(1);  // positive control: there is a holder to lose
    // The terminal's own program, a child of its holder: on macOS it shows no environment, so only its parent leads to it.
    const childrenOf = (parent: number): number[] => spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).stdout.split("\n")
      .map((l) => l.trim().split(/\s+/).map(Number)).filter(([, ppid]) => ppid === parent).map(([pid]) => pid!);
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
