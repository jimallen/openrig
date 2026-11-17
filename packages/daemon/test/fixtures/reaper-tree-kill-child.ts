// Child of orphan-reaper.test.ts (workspaces-o9o.90): arms the orphan watchdog over a victim that has LEFT this process's
// tree (double-forked, so it is reparented away at once), as a private hc core's server leaves its test worker's tree when
// `hc server start` daemonizes it. Reports the victim and waits to be killed without any teardown.
import { execFileSync } from "node:child_process";
import { identityOf, reapWhenOwnerDies } from "../helpers/orphan-reaper.js";

// The intermediate shell backgrounds the sleep and exits, so the sleep is reparented (to the nearest subreaper or init).
const victimPid = Number(execFileSync("/bin/sh", ["-c", "sleep 600 </dev/null >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).trim());
const victim = identityOf(victimPid);
if (victim === null) throw new Error(`the victim ${victimPid} could not be read`);
reapWhenOwnerDies({ identities: [victim], label: "tree-kill-fixture" });
process.stdout.write(`READY ${victimPid}\n`);
setInterval(() => {}, 1000);
