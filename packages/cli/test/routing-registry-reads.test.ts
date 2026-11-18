// workspaces-o9o.160: the routing registries the CLI reads are held to the credential rule. daemon.json and config.json choose the
// URL the CLI sends the terminal token to, so a daemon.json that is a link, or another user's, is not used; group/other write on
// OpenRig's own files is narrowed, never refused. config.json may be a link (its writer follows one by design; CoS 11-18 13:36Z),
// and its real target is judged and narrowed. Every fixture sets its own mode.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DaemonClient } from "../src/client.js";
import { ConfigStore } from "../src/config-store.js";
import { getDaemonStatus, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import { realDeps } from "../src/commands/daemon.js";

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cli-routing-")));
  vi.stubEnv("OPENRIG_HOME", dir);
  vi.stubEnv("OPENRIG_URL", "");
  vi.stubEnv("RIGGED_URL", "");
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

const STATE = JSON.stringify({ pid: 4242, port: 41111, host: "127.0.0.1" });
const put = (p: string, text: string, mode: number) => { fs.writeFileSync(p, text); fs.chmodSync(p, mode); };

describe("the CLI's daemon URL comes only from a daemon.json that passes the rule (o9o.160)", () => {
  it("CONTROL: a plain daemon.json of ours routes the client", () => {
    put(path.join(dir, "daemon.json"), STATE, 0o644);
    expect(new DaemonClient().baseUrl).toContain(":41111");
  });

  it("a daemon.json that is a link does not route the client (the terminal token would go where it points)", () => {
    put(path.join(dir, "elsewhere.json"), STATE, 0o644);
    fs.symlinkSync(path.join(dir, "elsewhere.json"), path.join(dir, "daemon.json"));
    expect(new DaemonClient().baseUrl).not.toContain(":41111");
  });

  it("a daemon.json of ours others can change is narrowed (never refused) and used", () => {
    put(path.join(dir, "daemon.json"), STATE, 0o666);
    expect(new DaemonClient().baseUrl).toContain(":41111");
    expect(fs.statSync(path.join(dir, "daemon.json")).mode & 0o777).toBe(0o644);
  });
});

describe("config.json is read under the rule, through a link if it is one (o9o.160)", () => {
  it("a config.json of ours others can change is narrowed and read", () => {
    const p = path.join(dir, "config.json");
    put(p, JSON.stringify({ daemon: { port: 40001 } }), 0o664);
    expect(new ConfigStore(p).resolve().daemon.port).toBe(40001);
    expect(fs.statSync(p).mode & 0o777).toBe(0o644);
  });

  it("a symlinked config.json (dotfiles) is read, and its TARGET is narrowed, the link kept", () => {
    const target = path.join(dir, "dotfiles-config.json");
    put(target, JSON.stringify({ daemon: { port: 40002 } }), 0o664);
    fs.symlinkSync(target, path.join(dir, "config.json"));
    expect(new ConfigStore(path.join(dir, "config.json")).resolve().daemon.port).toBe(40002);
    expect(fs.statSync(target).mode & 0o777).toBe(0o644);
    expect(fs.lstatSync(path.join(dir, "config.json")).isSymbolicLink()).toBe(true);
  });

  it("a config.json that is not a plain file is refused, naming it", () => {
    fs.mkdirSync(path.join(dir, "config.json"), { mode: 0o700 });
    expect(() => new ConfigStore(path.join(dir, "config.json")).resolve()).toThrow(/config\.json.*not a regular file/);
  });
});

describe("the lifecycle reads daemon.json through its rule seam (o9o.160)", () => {
  const lifecycle = (readStateFile: (p: string) => string | null): LifecycleDeps => ({
    spawn: () => { throw new Error("not spawned in this test"); },
    fetch: async () => ({ ok: false }),
    kill: () => true,
    readFile: () => STATE,
    readStateFile,
    writeFile: () => {},
    removeFile: () => {},
    exists: () => true,
    mkdirp: () => {},
    openForAppend: () => 3,
    isProcessAlive: () => true,
  });

  it("CONTROL: a state file the seam returns is used", async () => {
    expect((await getDaemonStatus(lifecycle(() => STATE))).port).toBe(41111);
  });

  it("prefers readStateFile over readFile: a state the rule refuses is not used even if readFile would return it", async () => {
    expect((await getDaemonStatus(lifecycle(() => null))).port).not.toBe(41111);
  });

  it("realDeps().readStateFile refuses a symlinked daemon.json and narrows a group-writable one", () => {
    const deps = realDeps();
    put(path.join(dir, "elsewhere.json"), STATE, 0o644);
    fs.symlinkSync(path.join(dir, "elsewhere.json"), path.join(dir, "state-link.json"));
    expect(deps.readStateFile?.(path.join(dir, "state-link.json"))).toBeNull();
    put(path.join(dir, "state.json"), STATE, 0o664);
    expect(deps.readStateFile?.(path.join(dir, "state.json"))).toBe(STATE);
    expect(fs.statSync(path.join(dir, "state.json")).mode & 0o777).toBe(0o644);
  });
});
