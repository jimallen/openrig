import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HcClient, resolveHcSocket } from "../../src/adapters/hc-client.js";
import { hcTerminalName, SEAT_LABEL } from "../../src/adapters/hc-host.js";
import { hcCountedSocketBytes, hcScratchBase, hcScratchFallback, hcServerUntilUp, hcSocketFits, HC_SOCKET_PATH_LIMIT } from "./hc-scratch.js";
import { PrivateCoreGuard } from "./private-core-guard.js";
import { waitBound, waitTimedOut } from "./wait-timeout.js";

/** The `hc` on PATH, or "" when there is none (the real-core suites skip). */
export const HC = spawnSync("sh", ["-c", "command -v hc"], { encoding: "utf8" }).stdout.trim();

/** A core of its own: private HOME, XDG paths and HC_SESSION under a temp root, never the default core or the app. */
export class PrivateCore {
  readonly root = realpathSync(mkdtempSync(join(hcScratchBase(process.env, hcScratchFallback(tmpdir())), "hcp-")));
  readonly env: NodeJS.ProcessEnv;
  client!: HcClient;
  /** workspaces-o9o.163: reaps this core if the worker dies before stop() (private-core-guard.ts). */
  private readonly guard: PrivateCoreGuard;

  constructor() {
    const { root } = this;
    this.env = {
      PATH: process.env.PATH, HOME: join(root, "h"), HC_SESSION: `p${process.pid}`,
      XDG_CONFIG_HOME: join(root, "c"), XDG_DATA_HOME: join(root, "d"), XDG_STATE_HOME: join(root, "s"), XDG_RUNTIME_DIR: join(root, "r"),
    };
    this.guard = new PrivateCoreGuard(this.env, root, "hc-private-core:helpers");
  }

  start(): void {
    for (const d of ["h", "c", "d", "s", "r"]) mkdirSync(join(this.root, d), { recursive: true, mode: 0o700 });
    const socket = resolveHcSocket(this.env, this.env.HOME);
    // Measured as hc measures it (the socket plus HC_SOCKET_PATH_RESERVE), so a root hc would refuse is refused here first.
    if (!hcSocketFits(socket)) throw new Error(`hc private core: the socket path would be ${hcCountedSocketBytes(socket)} bytes as hc counts it (limit ${HC_SOCKET_PATH_LIMIT}): ${socket}`);
    this.guard.arm(); // before the core exists: the window in which a killed worker leaves it behind begins at start
    hcServerUntilUp(HC, this.env, "start");
    this.client = new HcClient(socket);
  }

  /** `hc server restart`, with the start-budget recovery (workspaces-o9o.80). */
  restart(): void {
    this.guard.arm();
    hcServerUntilUp(HC, this.env, "restart");
  }

  stop(): void {
    spawnSync(HC, ["server", "stop"], { env: this.env, stdio: "ignore" });
    this.guard.releaseWhenStopped(); // a core not seen stopped keeps its guard, which reaps it when the worker ends
    rmSync(this.root, { recursive: true, force: true });
  }

  /** A seat's terminal running `script` under sh, named and labelled as HcHost names a seat. */
  async runSeat(seat: string, script: string, labels: Record<string, string> = {}): Promise<void> {
    await this.client.call("terminal.run", {
      argv: ["sh", "-c", script], name: hcTerminalName(seat), labels: { [SEAT_LABEL]: seat, ...labels }, cwd: this.root,
      no_parent: true, no_notify: true, outlive_parent: true,
    });
  }
}

/** Polls until `read` answers what `ok` accepts (expect.poll works only inside a test, and the suites set up in beforeAll). */
export async function waitUntil<T>(read: () => Promise<T>, ok: (value: T) => boolean, what: string, timeoutMs = 15_000): Promise<T> {
  const bound = waitBound(timeoutMs);
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (bound.expired()) throw waitTimedOut(`timed out waiting for ${what}`, bound);
    await new Promise((r) => setTimeout(r, 100));
  }
}
