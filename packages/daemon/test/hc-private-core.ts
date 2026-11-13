import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { HcClient, resolveHcSocket } from "../src/adapters/hc-client.js";
import { hcCountedSocketBytes, hcScratchBase, hcScratchFallback, hcSocketFits, HC_SOCKET_PATH_LIMIT } from "./helpers/hc-scratch.js";

export const HC = spawnSync("sh", ["-c", "command -v hc"], { encoding: "utf8" }).stdout.trim();

/** A core of the test's own: its own HOME, session and XDG paths, so the host's core and the app are never contacted.
 *  Every pid this signals is read from this core's own `server.status` and checked against its environment first. */
export class PrivateCore {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly socketPath: string;
  readonly client: HcClient;

  constructor(tag: string, extraEnv: NodeJS.ProcessEnv = {}) {
    this.root = mkdtempSync(join(hcScratchBase(process.env, hcScratchFallback(tmpdir())), `hc-${tag}-`));
    this.env = {
      PATH: process.env.PATH, HOME: join(this.root, "h"), HC_SESSION: `${tag}${process.pid}`,
      XDG_CONFIG_HOME: join(this.root, "c"), XDG_DATA_HOME: join(this.root, "d"), XDG_STATE_HOME: join(this.root, "s"), XDG_RUNTIME_DIR: join(this.root, "r"),
      ...extraEnv,
    };
    for (const d of ["h", "c", "d", "s", "r"]) mkdirSync(join(this.root, d), { recursive: true, mode: 0o700 });
    this.socketPath = resolveHcSocket(this.env, this.env.HOME);
    // Measured as hc measures it (the socket plus HC_SOCKET_PATH_RESERVE), so a root hc would refuse is refused here first.
    if (!hcSocketFits(this.socketPath)) {
      rmSync(this.root, { recursive: true, force: true });
      throw new Error(`hc private core: the socket path would be ${hcCountedSocketBytes(this.socketPath)} bytes as hc counts it (limit ${HC_SOCKET_PATH_LIMIT}): ${this.socketPath}`);
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
   * The pid is this core's own process (or its holder): on Linux its environment names this core's session and its runtime dir (/proc). Elsewhere `ps -Ewwo`
   * shows the environment of an ordinary child, but not of hc 0.1.17's core, which is `hc --hc-launchd`, parent 1, and shows none; then the
   * process is identified by the socket it listens on (`lsof -U`): this core's own socket path exactly, or a holder socket in the same
   * directory under this session's name. A real core listens on the account's path, never on a path under this test's root, so no pid of
   * a real core can pass. False when unreadable.
   */
  isMine(pid: number): boolean {
    const entry = `HC_SESSION=${this.env.HC_SESSION}`;
    try {
      if (existsSync("/proc/self/environ")) {
        // The session name alone is not an identity: another core made by the same test run can share it. The runtime dir is this core's own.
        const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
        return environ.includes(entry) && environ.includes(`XDG_RUNTIME_DIR=${this.env.XDG_RUNTIME_DIR}`);
      }
      const out = spawnSync("ps", ["-Ewwo", "command=", "-p", String(pid)], { encoding: "utf8" });
      if (out.status !== 0) return false;
      // The entry must be a whole word of the environment, and absent from the arguments `ps -o command` alone reports.
      const argv = spawnSync("ps", ["-wwo", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout;
      if (` ${out.stdout.trim()} `.includes(` ${entry} `) && !` ${argv.trim()} `.includes(` ${entry} `)) return true;
      return this.listensOnMySocket(pid);
    } catch {
      return false;
    }
  }

  /** True when the process holds a listening unix socket that is this core's socket, or this session's holder socket beside it. */
  private listensOnMySocket(pid: number): boolean {
    const lsof = ["/usr/sbin/lsof", "/usr/bin/lsof"].find((candidate) => existsSync(candidate));
    if (!lsof) return false;
    const out = spawnSync(lsof, ["-nP", "-a", "-p", String(pid), "-U", "-Fn"], { encoding: "utf8" });
    const names = out.stdout.split("\n").filter((line) => line.startsWith("n/")).map((line) => line.slice(1));
    const session = this.env.HC_SESSION as string;
    return names.some((name) => name === this.socketPath || (dirname(name) === dirname(this.socketPath) && basename(name).startsWith(`${session}.holder.`) && name.endsWith(".sock")));
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
