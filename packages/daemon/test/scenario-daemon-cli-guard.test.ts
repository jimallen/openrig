import { describe, expect, it } from "vitest";
import { spawnScenarioDaemon } from "./helpers/scenario-daemon.js";
import type { HermeticScaffold } from "./helpers/hermetic-env.js";

// The daemon scenario/integration tests spawn the real CLI (packages/cli/dist/bin-wrapper.js). With the CLI not
// built, ~8 of them failed with a node "Cannot find module" buried inside "scenario-local daemon failed to start".
// The helper now says what to do. This pins the message the operator sees, at the one helper they all go through.

describe("spawnScenarioDaemon with the CLI not built", () => {
  it("fails at once and says to build the CLI first, naming the missing file", async () => {
    const missing = "/nonexistent-openrig-cli/dist/bin-wrapper.js";
    const scaffold = { root: "/scratch", env: {}, stateDir: "/scratch/state" } as unknown as HermeticScaffold;
    const failure = await spawnScenarioDaemon(scaffold, { rigBin: missing, timeoutMs: 1000 }).then(() => null, (err: Error) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message).toContain("Build it first (npm run build -w packages/cli)");
    expect(failure!.message).toContain(missing);
    expect(failure!.message).not.toContain("failed to start");
  });
});
