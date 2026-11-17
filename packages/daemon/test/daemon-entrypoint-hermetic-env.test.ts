import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { killIfRunning, spawnDaemonEntrypoint, testDaemonEnv, type EntrypointDaemon } from "./helpers/daemon-entrypoint.js";

// workspaces-o9o.61. spawnDaemonEntrypoint spread process.env into the test daemon. Inside vitest that env has already been
// scrubbed (test/hermetic-env.setup.ts), but a standalone tsx caller (incident 2026-11-16 ~20:50Z, build-impl4) handed the
// daemon the seat's HC_TERMINAL_SOCKET, XDG_RUNTIME_DIR and OPENRIG_TRANSCRIPTS_PATH, and the test daemons connected to the
// LIVE hc core. These tests put the seat's names back into process.env for their duration, as such a caller has them, and
// point every one at a FAKE in a temp dir: a unix socket that only counts connections, never the host's core.

const READY_MS = 90_000;
const tempDirs: string[] = [];
const daemons: EntrypointDaemon[] = [];
const servers: net.Server[] = [];
let restoreEnv: (() => void) | null = null;

function tempDir(prefix: string): string {
  // Short, so a socket path inside it stays under the platform's sun_path limit.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const d of daemons.splice(0)) killIfRunning(d.child);
  restoreEnv?.();
  restoreEnv = null;
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Set names in process.env for this test only (the way a caller outside vitest has them), restored after. */
function withCallerEnv(values: Record<string, string>): void {
  const saved = new Map(Object.keys(values).map((k) => [k, process.env[k]]));
  Object.assign(process.env, values);
  restoreEnv = () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** A fake hc core: a unix socket that records each connection and answers nothing. */
async function fakeCore(socketPath: string): Promise<{ connections: () => number }> {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  let n = 0;
  const server = net.createServer((sock) => { n += 1; sock.on("error", () => {}); sock.destroy(); });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => resolve()); });
  return { connections: () => n };
}

/** A preload that writes the daemon's own env, as the child sees it, beside its OPENRIG_HOME. */
function envDumpPreload(dir: string): string {
  const file = path.join(dir, "dump-env.mjs");
  fs.writeFileSync(file, [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'fs.writeFileSync(path.join(process.env.OPENRIG_HOME, "child-env.json"), JSON.stringify(process.env));',
  ].join("\n"));
  return file;
}

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

/** The seat's names that reach live state, each pointing at a fake under `root` (the folders exist, as a seat's do). */
function seatEnv(root: string): Record<string, string> {
  for (const dir of ["run", "state", "config", "data", "seat-home/.codex", "seat-home/.claude", "transcripts", "shared-docs", "rigged-home"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  return {
    HC_SOCKET: path.join(root, "hc.sock"),
    HC_TERMINAL_SOCKET: path.join(root, "hc-terminal.sock"),
    HC_SESSION: "default",
    HC_TERMINAL_ID: "t-fake",
    XDG_RUNTIME_DIR: path.join(root, "run"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    TMUX: `${path.join(root, "tmux.sock")},1,0`,
    TMUX_PANE: "%0",
    TMUX_TMPDIR: root,
    HOME: path.join(root, "seat-home"),
    CODEX_HOME: path.join(root, "seat-home", ".codex"),
    CLAUDE_CONFIG_DIR: path.join(root, "seat-home", ".claude"),
    OPENRIG_TRANSCRIPTS_PATH: path.join(root, "transcripts"),
    OPENRIG_SHARED_DOCS_ROOT: path.join(root, "shared-docs"),
    OPENRIG_SESSION_NAME: "impl@seat",
    OPENRIG_NODE_ID: "01SEATNODE",
    OPENRIG_HOST: "127.0.0.1",
    RIGGED_URL: "http://127.0.0.1:1",
    RIGGED_HOME: path.join(root, "rigged-home"),
  };
}

describe("o9o.61: a test daemon started outside vitest gets none of the caller's live state", () => {
  // The incident's env named the core through XDG_RUNTIME_DIR (HC_TERMINAL_SOCKET is the seat's own terminal, not read by the
  // resolver); HC_SOCKET names it first when set. One case per route, each with the fake at the path that route resolves to.
  it.each([
    { route: "XDG_RUNTIME_DIR (the incident's env)", drop: ["HC_SOCKET"], core: (root: string) => path.join(root, "run", "herdr-core", "default.sock") },
    { route: "HC_SOCKET", drop: [] as string[], core: (root: string) => path.join(root, "hc.sock") },
  ])("the caller's hc core named by $route is never contacted, while a private core passed as privateHcSocket is (positive control)", async ({ drop, core }) => {
    const root = tempDir("o9o61-");
    const ambient = await fakeCore(core(root));
    const toldHome = tempDir("o9o61-told-");
    const explicit = await fakeCore(path.join(toldHome, "own.sock"));
    const seat = seatEnv(root);
    for (const name of drop) delete seat[name];
    withCallerEnv(seat);

    // The same daemon, given a private core through the helper's seam, connects to it: so the observation is reachable, and a
    // core it was not told about stays untouched only because the helper withheld it.
    const told = await spawnDaemonEntrypoint({ home: toldHome, privateHcSocket: path.join(toldHome, "own.sock"), readyTimeoutMs: READY_MS });
    daemons.push(told);
    expect(await waitFor(() => explicit.connections() > 0, 20_000), "control: a privateHcSocket core is used").toBe(true);
    killIfRunning(told.child);
    const before = ambient.connections();

    const daemon = await spawnDaemonEntrypoint({ home: tempDir("o9o61-home-"), readyTimeoutMs: READY_MS });
    daemons.push(daemon);
    await waitFor(() => ambient.connections() > before, 20_000);
    expect(ambient.connections()).toBe(0);
  }, 240_000);

  it("the daemon's own env carries none of the seat's live-state names, and HOME is private to the test home", async () => {
    const root = tempDir("o9o61-");
    const seat = seatEnv(root);
    withCallerEnv(seat);
    const home = tempDir("o9o61-home-");
    const daemon = await spawnDaemonEntrypoint({
      home, nodeArgs: ["--import", pathToFileURL(envDumpPreload(root)).href], readyTimeoutMs: READY_MS,
    });
    daemons.push(daemon);
    const childEnv = JSON.parse(fs.readFileSync(path.join(home, "child-env.json"), "utf8")) as Record<string, string>;

    const carried = Object.entries(seat).filter(([k, v]) => childEnv[k] === v).map(([k]) => k);
    expect(carried).toEqual([]);
    // Any value naming the seat's fake root at all (a derived path, a name not in the list) is a leak too.
    expect(Object.entries(childEnv).filter(([, v]) => typeof v === "string" && v.includes(root)).map(([k]) => k)).toEqual([]);
    expect(childEnv["HOME"]?.startsWith(home + path.sep), `HOME=${childEnv["HOME"]}`).toBe(true);
    // Every place the daemon's children find a server or keep state is under the test home: with no TMUX_TMPDIR, tmux's default
    // server is the operator's (/tmp/tmux-<uid>/default); with no XDG_STATE_HOME, hc's socket falls back to HOME (private too).
    for (const name of ["TMUX_TMPDIR", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) {
      expect(childEnv[name]?.startsWith(home + path.sep), `${name}=${childEnv[name]}`).toBe(true);
    }
    // The names the daemon needs still reach it (the allow-list is not empty).
    expect(childEnv["PATH"]).toBe(process.env["PATH"]);
    expect(childEnv["OPENRIG_HOME"]).toBe(home);
    expect(childEnv["OPENRIG_HC_NO_START_CORE"]).toBe("1");
  }, 240_000);
});

// Review of f56e9f131 (verify-qa2): opts.env was spread AFTER the private values, so a caller could put the live routing back
// ({ env: { XDG_RUNTIME_DIR: <live> } }). The helper now refuses any state-routing name in opts.env, and pins its own values last.
describe("o9o.61: opts.env cannot route a test daemon to live state", () => {
  /** Spawn with `opts`; "refused" when the helper refuses, else the fake core's connection count after a wait. */
  async function outcome(opts: Parameters<typeof spawnDaemonEntrypoint>[0], core: { connections: () => number }): Promise<"refused" | number> {
    try {
      const d = await spawnDaemonEntrypoint(opts);
      daemons.push(d);
      await waitFor(() => core.connections() > 0, 20_000);
      return core.connections();
    } catch (error) {
      if (/may not name/.test(String(error))) return "refused";
      throw error;
    }
  }

  it.each([
    { name: "XDG_RUNTIME_DIR", value: (root: string) => path.join(root, "run"), core: (root: string) => path.join(root, "run", "herdr-core", "default.sock") },
    { name: "XDG_STATE_HOME", value: (root: string) => path.join(root, "state"), core: (root: string) => path.join(root, "state", "herdr-core", "default", "default.sock") },
    { name: "HC_SOCKET", value: (root: string) => path.join(root, "hc.sock"), core: (root: string) => path.join(root, "hc.sock") },
  ])("an opts.env naming a live-looking $name is refused, and its fake core is never contacted", async ({ name, value, core }) => {
    const root = tempDir("o9o61-");
    const fake = await fakeCore(core(root));
    expect(await outcome({ home: tempDir("o9o61-home-"), env: { [name]: value(root) }, readyTimeoutMs: READY_MS }, fake)).toBe("refused");
    expect(fake.connections()).toBe(0);
  }, 240_000);

  it("an opts.env naming HOME is refused (it would have become the daemon's own HOME)", async () => {
    const root = tempDir("o9o61-");
    const seatHome = path.join(root, "seat-home");
    fs.mkdirSync(seatHome, { recursive: true });
    const home = tempDir("o9o61-home-");
    let childHome: string | null = null;
    try {
      const d = await spawnDaemonEntrypoint({ home, env: { HOME: seatHome }, nodeArgs: ["--import", pathToFileURL(envDumpPreload(root)).href], readyTimeoutMs: READY_MS });
      daemons.push(d);
      childHome = (JSON.parse(fs.readFileSync(path.join(home, "child-env.json"), "utf8")) as Record<string, string>)["HOME"] ?? null;
    } catch (error) {
      expect(String(error)).toMatch(/may not name HOME/);
    }
    expect(childHome, "the daemon was started with a HOME from opts.env").toBeNull();
  }, 240_000);

  it.each(["HOME", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "TMUX", "TMUX_TMPDIR", "HC_SESSION", "OPENRIG_TRANSCRIPTS_PATH", "OPENRIG_DB", "RIGGED_HOME",
    "CODEX_HOME", "CLAUDE_CONFIG_DIR"])("testDaemonEnv refuses %s in opts.env", (name) => {
    expect(() => testDaemonEnv({ home: "/tmp/h", env: { [name]: "/elsewhere" } }, 1)).toThrow(new RegExp(`may not name ${name}`));
  });

  it("testDaemonEnv keeps a PATH stub (the simulator's), and a privateHcSocket outside the test home is refused", () => {
    const home = tempDir("o9o61-h-");
    expect(testDaemonEnv({ home, env: { PATH: "/stub:/usr/bin" } }, 1)["PATH"]).toBe("/stub:/usr/bin");
    expect(testDaemonEnv({ home, privateHcSocket: path.join(home, "core.sock") }, 1)["HC_SOCKET"]).toBe(path.join(home, "core.sock"));
    expect(() => testDaemonEnv({ home, privateHcSocket: "/run/user/1000/herdr-core/default.sock" }, 1)).toThrow(/not under the test home/);
    expect(() => testDaemonEnv({ home, privateHcSocket: `${home}-other/core.sock` }, 1)).toThrow(/not under the test home/);
  });

  // Review of 2529eac37 (verify-qa2): the containment was lexical, so a folder inside the home that is a symlink to an outside one
  // carried the socket out. Containment is now judged on real paths, for the socket itself when it exists, else its folder.
  it.each([
    { via: "a symlinked folder inside the home", place: (home: string, outside: string) => {
      fs.symlinkSync(outside, path.join(home, "linked"));
      return path.join(home, "linked", "fake-core.sock");
    } },
    { via: "a socket inside the home that is a symlink to an outside one", place: (home: string, outside: string) => {
      fs.symlinkSync(path.join(outside, "fake-core.sock"), path.join(home, "core.sock"));
      return path.join(home, "core.sock");
    } },
  ])("a privateHcSocket that reaches an outside core through $via is refused, and that core is never contacted", async ({ place }) => {
    const outside = tempDir("o9o61-outside-");
    const sentinel = await fakeCore(path.join(outside, "fake-core.sock"));
    const home = tempDir("o9o61-home-");
    let refused = false;
    try {
      const d = await spawnDaemonEntrypoint({ home, privateHcSocket: place(home, outside), readyTimeoutMs: READY_MS });
      daemons.push(d);
      await waitFor(() => sentinel.connections() > 0, 20_000);
    } catch (error) {
      expect(String(error)).toMatch(/not under the test home/);
      refused = true;
    }
    expect({ refused, outsideConnections: sentinel.connections() }).toEqual({ refused: true, outsideConnections: 0 });
  }, 240_000);
});
