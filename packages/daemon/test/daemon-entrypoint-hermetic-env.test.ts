import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { killIfRunning, spawnDaemonEntrypoint, type EntrypointDaemon } from "./helpers/daemon-entrypoint.js";

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
  ])("the caller's hc core named by $route is never contacted, while a core passed in opts.env is (positive control)", async ({ drop, core }) => {
    const root = tempDir("o9o61-");
    const ambient = await fakeCore(core(root));
    const explicit = await fakeCore(path.join(root, "own.sock"));
    const seat = seatEnv(root);
    for (const name of drop) delete seat[name];
    withCallerEnv(seat);

    // The same daemon, told about a core through the helper's own env option, connects to it: so the observation is reachable,
    // and a core it was not told about stays untouched only because the helper withheld it.
    const told = await spawnDaemonEntrypoint({ home: tempDir("o9o61-told-"), env: { HC_SOCKET: path.join(root, "own.sock") }, readyTimeoutMs: READY_MS });
    daemons.push(told);
    expect(await waitFor(() => explicit.connections() > 0, 20_000), "control: a core passed in opts.env is used").toBe(true);
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
