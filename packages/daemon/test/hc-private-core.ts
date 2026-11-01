import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HcClient, resolveHcSocket } from "../src/adapters/hc-client.js";
import { hcScratchBase, HC_SOCKET_PATH_LIMIT } from "./helpers/hc-scratch.js";

export const HC = spawnSync("sh", ["-c", "command -v hc"], { encoding: "utf8" }).stdout.trim();

/** A core of the test's own: its own HOME, session and XDG paths, so the host's core and the app are never contacted.
 *  Every pid this signals is read from this core's own `server.status` and checked against its environment first. */
export class PrivateCore {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly socketPath: string;
  readonly client: HcClient;

  constructor(tag: string, extraEnv: NodeJS.ProcessEnv = {}) {
    this.root = mkdtempSync(join(hcScratchBase(process.env, tmpdir()), `hc-${tag}-`));
    this.env = {
      PATH: process.env.PATH, HOME: join(this.root, "h"), HC_SESSION: `${tag}${process.pid}`,
      XDG_CONFIG_HOME: join(this.root, "c"), XDG_DATA_HOME: join(this.root, "d"), XDG_STATE_HOME: join(this.root, "s"), XDG_RUNTIME_DIR: join(this.root, "r"),
      ...extraEnv,
    };
    for (const d of ["h", "c", "d", "s", "r"]) mkdirSync(join(this.root, d), { recursive: true, mode: 0o700 });
    this.socketPath = resolveHcSocket(this.env, this.env.HOME);
    if (Buffer.byteLength(this.socketPath) > HC_SOCKET_PATH_LIMIT) {
      rmSync(this.root, { recursive: true, force: true });
      throw new Error(`hc private core: the socket path would be ${Buffer.byteLength(this.socketPath)} bytes (limit ${HC_SOCKET_PATH_LIMIT}): ${this.socketPath}`);
    }
    this.client = new HcClient(this.socketPath);
  }

  start(): void {
    execFileSync(HC, ["server", "start"], { env: this.env, stdio: "ignore" });
  }

  restart(): void {
    execFileSync(HC, ["server", "restart"], { env: this.env, stdio: "ignore" });
  }

  stop(): void {
    spawnSync(HC, ["server", "stop"], { env: this.env, stdio: "ignore" });
    rmSync(this.root, { recursive: true, force: true });
  }

  /**
   * The pid is this core's own process: its environment names this core's session. Read from /proc on Linux and from `ps -Ewwo`
   * on macOS (which shows the environment of the core's own unprotected `hc` processes). False when unreadable.
   */
  isMine(pid: number): boolean {
    const entry = `HC_SESSION=${this.env.HC_SESSION}`;
    try {
      if (existsSync("/proc/self/environ")) return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(entry);
      const out = spawnSync("ps", ["-Ewwo", "command=", "-p", String(pid)], { encoding: "utf8" });
      if (out.status !== 0) return false;
      // The entry must be a whole word of the environment, and absent from the arguments `ps -o command` alone reports.
      const argv = spawnSync("ps", ["-wwo", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout;
      return ` ${out.stdout.trim()} `.includes(` ${entry} `) && !` ${argv.trim()} `.includes(` ${entry} `);
    } catch {
      return false;
    }
  }

  async corePid(): Promise<number> {
    return (await this.client.call<{ pid: number }>("server.status")).pid;
  }

  async holderPid(): Promise<number> {
    const status = await this.client.call<{ holder: { pid: number } | null }>("server.status");
    if (!status.holder) throw new Error("no holder");
    return status.holder.pid;
  }
}

export async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, what: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(value)?.slice(0, 300)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
