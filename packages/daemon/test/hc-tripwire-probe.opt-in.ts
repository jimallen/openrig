// The child run of hc-hermetic-harness.test.ts ("hc scratch tripwire: the run fails (real vitest)"), not a test of the suite.
// It makes (and optionally removes) a root the way hc-scratch names it, and registers it the way hc-scratch does, in the child run's
// own registry (the child's setup made it; the owner pid differs from the parent's). The parent runs it with
//   vitest run -c vitest.opt-in.config.ts test/hc-tripwire-probe.opt-in.ts
// and OPENRIG_HC_TRIPWIRE_PROBE_BASE set; without that variable it fails rather than skips.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { HC_SCRATCH_REGISTRY_ENV, registerHcScratchRoot } from "../../../test/hc-scratch-tripwire.js";

it("hc tripwire probe: leaves a scratch root behind unless told to clean it", () => {
  const base = process.env.OPENRIG_HC_TRIPWIRE_PROBE_BASE;
  if (!base) throw new Error("hc tripwire probe: run only as hc-hermetic-harness.test.ts's child, with OPENRIG_HC_TRIPWIRE_PROBE_BASE set");
  const root = join(base, "hcs-probe1");
  mkdirSync(root);
  registerHcScratchRoot(root, "hc-tripwire-probe.opt-in.ts probe");
  if (process.env.OPENRIG_HC_TRIPWIRE_PROBE_CLEANS === "1") rmSync(root, { recursive: true, force: true });
  // workspaces-o9o.150 (verify-qa2): remove the run's own registry, so the end-of-run scan cannot read it.
  if (process.env.OPENRIG_HC_TRIPWIRE_PROBE_BREAK_REGISTRY === "1") {
    const registry = process.env[HC_SCRATCH_REGISTRY_ENV];
    if (!registry) throw new Error("hc tripwire probe: the child run has no hc scratch registry to remove");
    rmSync(registry, { recursive: true, force: true });
  }
});
