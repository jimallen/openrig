// OF-231 regeneration, not a check: rewrites src/adapters/runner-pane-width-table.ts from the character widths a PRIVATE hc core
// draws (helpers/hc-scratch.ts; the host's core is never contacted). Not collected by `npm test`; run it with
//   cd packages/daemon && npx vitest run -c vitest.opt-in.config.ts test/runner-pane-width-table.opt-in.ts
// runner-pane-width.real.test.ts's sweep row then says whether the hc on PATH agrees with the table.
import { afterAll, beforeAll, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { findHc, startHcScratch, type HcScratch } from "./helpers/hc-scratch.js";
import { paneWidthTableSource, sweepCoreWidths } from "./helpers/hc-width-sweep.js";

let scratch: HcScratch | undefined;
beforeAll(() => {
  if (!findHc()) throw new Error("the regeneration needs hc on PATH");
  scratch = startHcScratch();
});
afterAll(() => { scratch?.cleanup(); });

it("regenerates runner-pane-width-table.ts from this core", async () => {
  const version = spawnSync(findHc()!, ["--version"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(fileURLToPath(new URL("../src/adapters/runner-pane-width-table.ts", import.meta.url)), paneWidthTableSource(await sweepCoreWidths(scratch!), version));
}, 180_000);
