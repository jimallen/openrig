// OF-82: removes the fixture homes that test/hermetic-env.setup.ts created but whose own `afterAll`
// never ran. vitest does not run hooks for a file whose tests are all skipped (describe.skip,
// skipIf), yet the setup file has already created that worker's `.openrig-test-fixture-home-*`
// and `-user-home` pair by then. A globalSetup runs in the main process and its teardown runs
// once at the end of the run, so it is the one place that cannot be skipped by a skipped file.
//
// Contract with the setup file: `setup` publishes a registry directory in
// OPENRIG_TEST_FIXTURE_REGISTRY (inherited by the worker processes). A worker that creates a
// fixture home writes a file there holding the home's absolute path. `teardown` removes every
// registered home and its `-user-home` sibling, then the registry. Nothing is matched by name in
// the shared temp dir, so a concurrent run's homes are never touched. Idempotent: several vitest
// projects may each load this file in the same main process.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createHcScratchRegistry, describeLeak, findLeakedHcScratch, HC_SCRATCH_REGISTRY_ENV, HC_SCRATCH_REGISTRY_OWNER_ENV, ownsHcScratchRegistry,
} from "./hc-scratch-tripwire.js";

export const FIXTURE_REGISTRY_ENV = "OPENRIG_TEST_FIXTURE_REGISTRY";
// The pid of the main process that created the registry. A vitest started from inside a test
// inherits both variables; seeing another pid there, it makes its own registry instead of reusing
// (and later removing) the outer run's.
export const FIXTURE_HOME_PREFIX = ".openrig-test-fixture-home-";
/** The short state dir the setup file makes where the fixture home's own socket path would be over the platform limit (macOS). */
export const FIXTURE_SHORT_STATE_PREFIX = ".oh-";
const OWNER_ENV = "OPENRIG_TEST_FIXTURE_REGISTRY_OWNER";
const ownsRegistry = () => process.env[OWNER_ENV] === String(process.pid);

// hc cutover W8/W20: the run's private hc cores. `setup` makes a registry of them (test/hc-scratch-tripwire.ts); every
// `startHcScratch` of this run registers its root there; `teardown` fails the run when a registered root is still on disk.
// Only the process that made the registry reads it: a worker that calls `teardown()` in process (fixture-home-cleanup.test.ts)
// inherits the variables with the main process's pid as owner, so it neither scans nor removes the run's live roots.

export function setup(): void {
  if (!(ownsRegistry() && process.env[FIXTURE_REGISTRY_ENV] && fs.existsSync(process.env[FIXTURE_REGISTRY_ENV]!))) {
    process.env[FIXTURE_REGISTRY_ENV] = fs.mkdtempSync(path.join(os.tmpdir(), ".openrig-test-fixture-registry-"));
    process.env[OWNER_ENV] = String(process.pid);
  }
  createHcScratchRegistry(process.env, os.tmpdir());
}

export function teardown(): void {
  // Read what the hc part needs first: the fixture part below may return early or clear the shared variables.
  const hcRegistry = ownsHcScratchRegistry() ? process.env[HC_SCRATCH_REGISTRY_ENV]! : null;
  try {
    removeFixtureHomes();
  } finally {
    // Last, after the fixture homes are gone, so a failing tripwire never leaves them behind.
    if (hcRegistry) {
      delete process.env[HC_SCRATCH_REGISTRY_ENV];
      delete process.env[HC_SCRATCH_REGISTRY_OWNER_ENV];
    }
  }
  if (!hcRegistry) return;
  let leaked;
  try {
    leaked = findLeakedHcScratch(hcRegistry);
  } finally {
    try { fs.rmSync(hcRegistry, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (leaked.length > 0) throw new Error(describeLeak(leaked));
}

function removeFixtureHomes(): void {
  const registry = process.env[FIXTURE_REGISTRY_ENV];
  if (!ownsRegistry() || !registry || !fs.existsSync(registry)) return;
  for (const entry of fs.readdirSync(registry)) {
    let home = "";
    try { home = fs.readFileSync(path.join(registry, entry), "utf8"); } catch { continue; }
    // Only paths this suite names as fixture homes are ever removed, whatever a registry file says.
    if (!path.basename(home).startsWith(FIXTURE_HOME_PREFIX) && !path.basename(home).startsWith(FIXTURE_SHORT_STATE_PREFIX)) continue;
    for (const dir of [home, `${home}-user-home`]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
  try { fs.rmSync(registry, { recursive: true, force: true }); } catch { /* best effort */ }
  delete process.env[FIXTURE_REGISTRY_ENV];
  delete process.env[OWNER_ENV];
}
