// Child of orphan-reaper.test.ts: starts a scenario daemon through the real helper (against a stand-in `rig`), reports the
// daemon's scaffold, its hc core's root and pid, and then waits to be killed WITHOUT running any teardown, as a timed-out or killed test worker would.
import { prepareHermeticEnv } from "../helpers/hermetic-env.js";
import { spawnScenarioDaemon } from "../helpers/scenario-daemon.js";

const rigBin = process.argv[2]!;
const scaffold = prepareHermeticEnv();
await spawnScenarioDaemon(scaffold, { rigBin, timeoutMs: 30_000 });
// The helper starts the scaffold's private hc core. A killed worker's guard stops it but keeps its root as evidence (hc-scratch.ts),
// so the parent test removes that root once the core is gone: report where it is and which process is the core.
const core = scaffold.hcCore;
if (core === null) throw new Error("the scenario daemon helper started no hc core of the scaffold's");
const status = JSON.parse(core.run(["server", "status", "--json"]).stdout) as { pid: number };
process.stdout.write(`READY ${scaffold.root} ${core.root} ${status.pid}\n`);
setInterval(() => {}, 1000);
