// Child of orphan-reaper.test.ts: starts a scenario daemon through the real helper (against a stand-in `rig`), reports the
// daemon's pid, and then waits to be killed WITHOUT running any teardown, as a timed-out or killed test worker would.
import { prepareHermeticEnv } from "../helpers/hermetic-env.js";
import { spawnScenarioDaemon } from "../helpers/scenario-daemon.js";

const rigBin = process.argv[2]!;
const scaffold = prepareHermeticEnv();
await spawnScenarioDaemon(scaffold, { rigBin, timeoutMs: 30_000 });
process.stdout.write(`READY ${scaffold.root}\n`);
setInterval(() => {}, 1000);
