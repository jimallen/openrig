import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { Command } from "commander";

export interface RsiDeps {
  run?: (command: string, args: string[]) => Pick<SpawnSyncReturns<Buffer>, "status" | "error">;
}

const realRun: NonNullable<RsiDeps["run"]> = (command, args) => spawnSync(command, args, { stdio: "inherit" });

/**
 * `rig rsi`: show the RSI inbox view. rig-here owns how the view opens in the Herdr app, so this only calls it.
 * A rig-here without the rsi mode reports that itself and exits non-zero; this passes its exit code through.
 */
export function rsiCommand(deps: RsiDeps = {}): Command {
  const run = deps.run ?? realRun;
  return new Command("rsi")
    .description("Show the RSI inbox in the Herdr app (runs rig-here rsi)")
    .action(() => {
      const result = run("rig-here", ["rsi"]);
      if (result.error) {
        console.error(`rig rsi: could not run rig-here: ${result.error.message}`);
        process.exitCode = 1;
        return;
      }
      process.exitCode = result.status ?? 1;
    });
}
