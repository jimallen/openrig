import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { Command } from "commander";

export interface HumanDeps {
  run?: (command: string, args: string[]) => Pick<SpawnSyncReturns<Buffer>, "status" | "error">;
}

const realRun: NonNullable<HumanDeps["run"]> = (command, args) => spawnSync(command, args, { stdio: "inherit" });

/** `rig human`: show the kernel's human seat. rig-here owns how a seat opens in the Herdr app, so this only calls it. */
export function humanCommand(deps: HumanDeps = {}): Command {
  const run = deps.run ?? realRun;
  return new Command("human")
    .description("Show the kernel's human seat in the Herdr app (runs rig-here kernel)")
    .action(() => {
      const result = run("rig-here", ["kernel"]);
      if (result.error) {
        console.error(`rig human: could not run rig-here: ${result.error.message}`);
        process.exitCode = 1;
        return;
      }
      process.exitCode = result.status ?? 1;
    });
}
