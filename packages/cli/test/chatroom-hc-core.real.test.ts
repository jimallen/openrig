import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { resolveHcSocket } from "@openrig/daemon/hc";
import { chatroomCommand, realHcDeps, type ChatroomHcDeps } from "../src/commands/chatroom.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type DaemonState, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

const HC = spawnSync("sh", ["-c", "command -v hc"], { encoding: "utf8" }).stdout.trim();

// The four names the daemon never hands to a seat or to a core it starts (hc-seat.ts OPERATOR_SECRET_ENV_NAMES, restated here).
const SECRETS = ["OPENRIG_AUTH_BEARER_TOKEN", "OPENRIG_TERMINAL_BEARER_TOKEN", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"];
const SECRET_VALUE = (name: string): string => `w31-fake-${name.toLowerCase()}`;

function lifecycle(port: number): StatusDeps {
  const state: DaemonState = { pid: 123, port, db: "t.sqlite", startedAt: "2026-04-01T00:00:00Z" };
  const base: LifecycleDeps = {
    spawn: () => { throw new Error("the lifecycle never spawns here"); },
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => (p === STATE_FILE ? JSON.stringify(state) : null)),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
  return { lifecycleDeps: base, clientFactory: (url) => new DaemonClient(url) };
}

/**
 * Security review F6 (`hc run` in `rig chatroom watch --terminal` had no guard against a wrong core), on a PRIVATE core only (own HOME,
 * XDG paths and HC_SESSION under one temp root, as hc-core-probe.real.test.ts). The caller's env holds fake operator secrets, as a CLI
 * that talks to an authenticated daemon does. The real `hc run` is used (realHcDeps); only the program the terminal runs is replaced by
 * one that writes its own env to a file, so what the core hands a terminal is read, not assumed.
 */
describe.skipIf(!HC)("rig chatroom watch --terminal never starts or feeds a core (private core)", () => {
  const root = mkdtempSync(join(tmpdir(), "crhc-"));
  const envFile = join(root, "terminal-env.txt");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: join(root, "h"), HC_SESSION: `w31${process.pid}`,
    XDG_CONFIG_HOME: join(root, "c"), XDG_DATA_HOME: join(root, "d"), XDG_STATE_HOME: join(root, "s"), XDG_RUNTIME_DIR: join(root, "r"),
  };
  const saved = { ...process.env };
  const socket = () => resolveHcSocket(env);
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    for (const d of ["h", "c", "d", "s", "r"]) mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
    for (const k of Object.keys(process.env)) if (/^(HC_|XDG_)/.test(k) || k === "HOME") delete process.env[k];
    Object.assign(process.env, env);
    for (const name of SECRETS) process.env[name] = SECRET_VALUE(name);
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([{ id: "rig-1", name: "my-rig", nodeCount: 1 }]));
    });
    port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    }));
  });
  afterAll(() => {
    server.close();
    spawnSync(HC, ["server", "stop"], { env, stdio: "ignore" });
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  });

  // The program writes to a temporary name and renames it: `env > file` creates the file empty before `env` writes, and the tests poll for the
  // file's existence, so a read could land in between and see '' (measured: a reader spinning on existsSync saw an empty file in 300 of 300
  // trials of `env > f`, 0 of 300 with write-then-rename).
  /** The real hc seam, with the program replaced: `sh -c 'env > file' x` after `chatroom watch my-rig` lands in sh as $0 and arguments. */
  const deps: ChatroomHcDeps = { ...realHcDeps, selfArgv: () => ["sh", "-c", `env > ${envFile}.tmp && mv ${envFile}.tmp ${envFile}`, "x"] };

  async function watch(): Promise<number | undefined> {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(chatroomCommand(lifecycle(port), deps));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const before = process.exitCode;
    process.exitCode = undefined;
    try { await prog.parseAsync(["node", "rig", "chatroom", "watch", "my-rig", "--terminal"]); } finally { log.mockRestore(); err.mockRestore(); }
    const code = typeof process.exitCode === "number" ? process.exitCode : undefined;
    process.exitCode = before;
    return code;
  }

  it("with no core: refuses with exit 1, and no core was started by the call", async () => {
    expect(existsSync(socket())).toBe(false);
    expect(await watch()).toBe(1);
    expect(existsSync(socket())).toBe(false);
  });

  it("with a core the caller did not start (clean env): the terminal runs, and neither its env nor the core's holds an operator secret", async () => {
    const cleanEnv: NodeJS.ProcessEnv = { ...env };  // no secrets: how the daemon starts a core
    expect(spawnSync(HC, ["server", "start"], { env: cleanEnv, encoding: "utf8" }).status).toBe(0);
    expect(existsSync(socket())).toBe(true);
    expect(await watch()).toBeUndefined();
    const until = Date.now() + 10_000;
    while (!existsSync(envFile) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    const terminalEnv = readFileSync(envFile, "utf8");
    expect(terminalEnv).toContain("OPENRIG_URL=http://127.0.0.1:");  // positive control: this is the terminal's env, and the daemon address is in it
    for (const name of SECRETS) expect(terminalEnv).not.toContain(name);
    // `--all`: the program is `env > file`, which exits at once, and a plain `hc ls` hides a finished terminal (measured on macOS,
    // hc 0.1.16: live at 100 ms, `{"hidden_finished":1,"terminals":[]}` by 2 s). Whether the terminal is still live when `ls` runs is a race.
    const ls = spawnSync(HC, ["ls", "--all", "--json"], { env: cleanEnv, encoding: "utf8" }).stdout;
    expect(ls).toContain("cr-951006fa75ef7730ec3258ce");  // the terminal is on this core: cr- + 24 hex of sha256("my-rig") (shasum -a 256)
  });

  it("control: the unguarded `hc run` from a caller holding the secrets starts a core that hands them to a terminal (the hazard the guard closes)", async () => {
    const dirs = ["h2", "c2", "d2", "s2", "r2"];
    for (const d of dirs) mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
    const env2: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: join(root, "h2"), HC_SESSION: `w31c${process.pid}`,
      XDG_CONFIG_HOME: join(root, "c2"), XDG_DATA_HOME: join(root, "d2"), XDG_STATE_HOME: join(root, "s2"), XDG_RUNTIME_DIR: join(root, "r2"),
    };
    const file2 = join(root, "control-env.txt");
    try {
      expect(existsSync(resolveHcSocket(env2))).toBe(false);
      const callerEnv = { ...env2, ...Object.fromEntries(SECRETS.map((n) => [n, SECRET_VALUE(n)])) };
      expect(spawnSync(HC, ["run", "--bg", "--name", "ctl", "--", "sh", "-c", `env > ${file2}.tmp && mv ${file2}.tmp ${file2}`], { env: callerEnv, encoding: "utf8" }).status).toBe(0);
      expect(existsSync(resolveHcSocket(env2))).toBe(true);
      const until = Date.now() + 10_000;
      while (!existsSync(file2) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      const terminalEnv = readFileSync(file2, "utf8");
      for (const name of SECRETS) expect(terminalEnv).toContain(name);
    } finally {
      spawnSync(HC, ["server", "stop"], { env: env2, stdio: "ignore" });
    }
  });
});
