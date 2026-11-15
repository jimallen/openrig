// The child run of hc-hermetic-harness.test.ts ("hc scratch tripwire: the run fails (real vitest)"), not a test of the suite.
// It makes (and optionally removes) a root the way hc-scratch names it, and registers it the way hc-scratch does, in the child run's
// own registry (the child's setup made it; the owner pid differs from the parent's). The parent runs it with
//   vitest run -c vitest.opt-in.config.ts test/hc-tripwire-probe.opt-in.ts
// and OPENRIG_HC_TRIPWIRE_PROBE_BASE set; without that variable it fails rather than skips.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { registerHcScratchRoot } from "../../../test/hc-scratch-tripwire.js";

it("hc tripwire probe: leaves a scratch root behind unless told to clean it", () => {
  const base = process.env.OPENRIG_HC_TRIPWIRE_PROBE_BASE;
  if (!base) throw new Error("hc tripwire probe: run only as hc-hermetic-harness.test.ts's child, with OPENRIG_HC_TRIPWIRE_PROBE_BASE set");
  const root = join(base, "hcs-probe1");
  mkdirSync(root);
  registerHcScratchRoot(root, "hc-tripwire-probe.opt-in.ts probe");
  if (process.env.OPENRIG_HC_TRIPWIRE_PROBE_CLEANS === "1") rmSync(root, { recursive: true, force: true });
});
