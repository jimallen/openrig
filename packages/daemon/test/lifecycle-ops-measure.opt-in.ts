// OF-241 measurement, not a check: how long a multi-seat rig down then restore of stub seats takes on a private hc core, and how
// long the lease is seen held. The stub starts at once, so this is OpenRig's own work per seat without a real agent's start-up
// (the bound for that, STARTUP_TEXT_WAIT_MS, is per seat). Not collected by `npm test`; run it with
//   cd packages/daemon && LOD_MEASURE_SEATS=27 npx vitest run -c vitest.opt-in.config.ts test/lifecycle-ops-measure.opt-in.ts
// It prints one `LOD-MEASURE {...}` line. Same daemon and core harness as lifecycle-ops.real.test.ts (helpers/lifecycle-ops-run.ts).
import { afterAll, beforeAll, expect, it } from "vitest";
import { HC, PrivateCore } from "./hc-private-core.js";
import { eventsOf, runLifecycleOp } from "./helpers/lifecycle-ops-run.js";

let core: PrivateCore | undefined;
beforeAll(() => {
  if (!HC) throw new Error("the measurement needs hc on PATH");
  core = new PrivateCore("lm");
  core.start();
});
afterAll(() => core?.stop());

it("measurement: rig down then restore of N stub seats, timed", async () => {
  const seats = Number(process.env.LOD_MEASURE_SEATS);
  if (!Number.isInteger(seats) || seats < 1) throw new Error("set LOD_MEASURE_SEATS to the number of stub seats to restore (the OF-241 run used 27)");
  const r = await runLifecycleOp(core!, "restore", { LOD_SEATS: String(seats), LOD_POLLS: "0" });
  const timing = eventsOf(r, "restore-timing")[0]!;
  // eslint-disable-next-line no-console
  console.log(`LOD-MEASURE ${JSON.stringify(timing)}`);
  expect(eventsOf(r, "child-error")).toEqual([]);
  expect(timing["seats"]).toBe(seats);
}, 600_000);
