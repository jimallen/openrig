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
import Database from "better-sqlite3";
import { readLocalOrigin } from "../src/local-origin.js";
import { crashCartCommand } from "../src/commands/crash-cart.js";
import { claimTestPort } from "../../daemon/test/helpers/test-ports.js";

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

// o9o.160 review (verify-sec2): three more daemon.json readers, each now under the same rule.
describe("the local origin's launch record is a daemon.json that passes the rule (o9o.160 review)", () => {
  const seed = (file: string, id: string) => {
    const db = new Database(file);
    db.exec("CREATE TABLE self_host_identity (singleton INTEGER PRIMARY KEY, host_id TEXT)");
    db.prepare("INSERT INTO self_host_identity VALUES (1, ?)").run(id);
    db.close();
  };
  // The configured default database lives in the suite's fixture home (ConfigStore captures it at import), not in `dir`.
  const defaultDb = (): string => String(new ConfigStore().resolveWithSource("db.path").value);
  beforeEach(() => {
    vi.stubEnv("OPENRIG_DB", "");
    vi.stubEnv("RIGGED_DB", "");
    seed(path.join(dir, "launch.sqlite"), "launch-origin");
  });
  afterEach(() => { fs.rmSync(defaultDb(), { force: true }); });
  const record = () => JSON.stringify({ db: path.join(dir, "launch.sqlite") });

  it("CONTROL: a plain daemon.json of ours chooses the database the origin is read from", () => {
    put(path.join(dir, "daemon.json"), record(), 0o600);
    expect(readLocalOrigin()).toBe("launch-origin");
  });

  it("a daemon.json that is a link does not choose the database, so its origin never reaches a request", async () => {
    put(path.join(dir, "elsewhere.json"), record(), 0o600);
    fs.symlinkSync(path.join(dir, "elsewhere.json"), path.join(dir, "daemon.json"));
    seed(defaultDb(), "default-origin"); // a refused record gives no origin, not the default database's
    expect(readLocalOrigin()).toBeUndefined();
    vi.stubEnv("OPENRIG_URL", "http://forwarded-endpoint:7433");
    vi.stubEnv("OPENRIG_SESSION_NAME", "rig-admin@ops");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const sent: Array<Record<string, string>> = [];
    const client = new DaemonClient("http://127.0.0.1:12345", { fetchImpl: (async (url, init) => {
      sent.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify(String(url).endsWith("/healthz") ? { selfHostId: "parent-origin" } : { ok: true }));
    }) as typeof fetch });
    await client.post("/write", {});
    expect(sent.at(-1)?.["X-OpenRig-Session"]).toBe("rig-admin@ops");
    expect(JSON.stringify(sent)).not.toContain("launch-origin");
    errors.mockRestore();
  });

  it("CONTROL: with no daemon.json the configured default database gives the origin", () => {
    seed(defaultDb(), "default-origin");
    expect(readLocalOrigin()).toBe("default-origin");
  });

  it("a daemon.json of ours others can change is narrowed (never refused) and chooses the database", () => {
    put(path.join(dir, "daemon.json"), record(), 0o664);
    expect(readLocalOrigin()).toBe("launch-origin");
    expect(fs.statSync(path.join(dir, "daemon.json")).mode & 0o777).toBe(0o644);
  });
});

describe("crash-cart's discovery reads a daemon.json that passes the rule (o9o.160 review)", () => {
  // The daemon is down: OPENRIG_URL and the record name a claimed free port (refused, never the live daemon's).
  // The record names this test's own live pid, so a record that is used refuses the direct read on that pid.
  // A free port claimed for this test process (workspaces-o9o.81): nothing listens on it, so the probe is refused.
  const deadPort = async (): Promise<number> => await claimTestPort();
  const record = (port: number) => JSON.stringify({ pid: process.pid, port, host: "127.0.0.1", db: path.join(dir, "missing.sqlite") });
  const runCart = async (port: number): Promise<{ state: string; refusal?: string; discovery?: unknown }> => {
    vi.stubEnv("OPENRIG_URL", `http://127.0.0.1:${port}`);
    const lines: string[] = [];
    await crashCartCommand({ write: (line) => { lines.push(line); } }).parseAsync(["--json"], { from: "user" });
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0] ?? "{}") as { state: string; refusal?: string; discovery?: unknown };
  };

  it("CONTROL: a plain daemon.json of ours with a live pid is what the cart judges by", async () => {
    const port = await deadPort();
    put(path.join(dir, "daemon.json"), record(port), 0o600);
    const out = await runCart(port);
    expect(JSON.stringify(out)).toContain(`pid ${process.pid}`);
  });

  it("a daemon.json that is a link is refused by the rule, never used for the pid or the database", async () => {
    const port = await deadPort();
    put(path.join(dir, "elsewhere.json"), record(port), 0o600);
    fs.symlinkSync(path.join(dir, "elsewhere.json"), path.join(dir, "daemon.json"));
    const out = await runCart(port);
    expect(out.state).toBe("down");
    expect(out.refusal).toContain("symbolic link");
    expect(out.refusal).not.toContain(`pid ${process.pid}`);
  });

  it("CONTROL: with no daemon.json the cart goes on to the configured database, no refusal about the record", async () => {
    const out = await runCart(await deadPort());
    expect(out.state).toBe("down");
    // The database step decides from here: the fixture home's database is read, or its absence is the refusal.
    expect(out.discovery !== undefined || /daemon DB not found/.test(out.refusal ?? "")).toBe(true);
  });

  it("a daemon.json of ours others can change is narrowed (never refused) and judged by", async () => {
    const port = await deadPort();
    put(path.join(dir, "daemon.json"), record(port), 0o664);
    const out = await runCart(port);
    expect(JSON.stringify(out)).toContain(`pid ${process.pid}`);
    expect(fs.statSync(path.join(dir, "daemon.json")).mode & 0o777).toBe(0o644);
  });
});

describe("the sibling-home hint reads daemon.json through the rule seam (o9o.160 review)", () => {
  const refused: LifecycleDeps["fetch"] = async () => {
    throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  };
  const sibling = "/fake/home/.openrig-build-vm-x/daemon.json";
  const lifecycle = (readStateFile: (p: string) => string | null): LifecycleDeps => ({
    spawn: () => { throw new Error("not spawned in this test"); },
    fetch: refused,
    kill: () => true,
    readFile: (p) => (p === sibling ? STATE : null),
    readStateFile,
    writeFile: () => {},
    removeFile: () => {},
    exists: (p) => p === sibling,
    mkdirp: () => {},
    openForAppend: () => 3,
    isProcessAlive: (pid) => pid === 4242,
    sleep: async () => {},
    homeDir: "/fake/home/.openrig",
    listDir: (p) => (p === "/fake/home" ? [".openrig", ".openrig-build-vm-x"] : []),
  });

  it("CONTROL: a sibling state the seam returns, with a live pid, makes the status unverified and names the sibling", async () => {
    const s = await getDaemonStatus(lifecycle((p) => (p === sibling ? STATE : null)));
    expect(s.state).toBe("unverified");
    expect(s.siblingHint?.siblingHome).toBe("/fake/home/.openrig-build-vm-x");
  });

  it("a sibling daemon.json the rule refuses gives no hint, even if readFile would return it", async () => {
    const s = await getDaemonStatus(lifecycle(() => null));
    expect(s.state).toBe("stopped");
    expect(s.siblingHint).toBeUndefined();
  });
});
