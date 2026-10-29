// Child of orphan-reaper.test.ts (OF-175): prepares a BARE hermetic scaffold (no scenario daemon and so no daemon watchdog),
// starts its tmux server the way the daemon does at boot (`tmux -D` through the scaffold's wrapper) and, on Linux, a process
// carrying the scaffold's OPENRIG_HOME, reports both, and then waits to be killed WITHOUT running any teardown, as a killed
// or timed-out test worker would.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { prepareHermeticEnv } from "../helpers/hermetic-env.js";
import { hasProcFs, tmuxServerPid } from "../helpers/orphan-reaper.js";

const scaffold = prepareHermeticEnv();
spawn("/bin/sh", ["-c", "tmux -D </dev/null >/dev/null 2>&1 &"], { env: scaffold.env, stdio: "ignore" });
let server: number | null = null;
for (let i = 0; i < 400 && server === null; i++) {
  if (existsSync(scaffold.tmuxSocketPath)) server = await tmuxServerPid(scaffold.tmuxSocketPath, scaffold.tmuxEnv);
  if (server === null) await new Promise((resolve) => setTimeout(resolve, 25));
}
if (server === null) throw new Error("the scaffold's tmux -D server never answered");
let carrier = 0;
if (hasProcFs()) {
  const child = spawn("/bin/sh", ["-c", "exec sleep 600"], { env: scaffold.env, stdio: "ignore", detached: true });
  child.unref();
  carrier = child.pid ?? 0;
}
process.stdout.write(`READY ${scaffold.root} ${server} ${carrier}\n`);
setInterval(() => {}, 1000);
