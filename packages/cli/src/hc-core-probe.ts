import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { resolveHcSocket } from "@openrig/daemon/hc";

// `hc get`, `hc ls` and `hc label` START a core when none runs, in the env of whoever asked (measured on a private core, hc 0.1.15;
// security review F6). A core born in a CLI caller's env hands that env to every terminal on it afterwards. So a CLI path that only
// wants to READ the core asks the socket first and never lets `hc` start one. The path is the daemon's own resolution (resolveHcSocket),
// so the CLI and the daemon agree on which core they mean; where they would differ, the answer here is "no core", which fails closed.

const PROBE_MS = 1_000;

/** Is something listening on the core's socket in this env? A stale socket file (nothing behind it) is not. */
export function hcCoreListening(env: NodeJS.ProcessEnv = process.env, timeoutMs = PROBE_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let path: string;
    try { path = resolveHcSocket(env); } catch { resolve(false); return; }
    const socket = createConnection(path);
    const done = (answer: boolean): void => { socket.destroy(); resolve(answer); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

const SYNC_PROBE = "const s=require('node:net').createConnection(process.argv[1]);s.once('connect',()=>process.exit(0));s.once('error',()=>process.exit(1));setTimeout(()=>process.exit(1),Number(process.argv[2]));";

/** The same question for a caller that cannot wait: a short node child does the connect (the socket path is an argument, never code). */
export function hcCoreListeningSync(env: NodeJS.ProcessEnv = process.env, timeoutMs = PROBE_MS): boolean {
  let path: string;
  try { path = resolveHcSocket(env); } catch { return false; }
  const child = spawnSync(process.execPath, ["-e", SYNC_PROBE, path, String(timeoutMs)], { timeout: timeoutMs + 2_000, stdio: "ignore" });
  return child.status === 0;
}
