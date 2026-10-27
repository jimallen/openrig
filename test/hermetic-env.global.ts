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

export const FIXTURE_REGISTRY_ENV = "OPENRIG_TEST_FIXTURE_REGISTRY";
// The pid of the main process that created the registry. A vitest started from inside a test
// inherits both variables; seeing another pid there, it makes its own registry instead of reusing
// (and later removing) the outer run's.
export const FIXTURE_HOME_PREFIX = ".openrig-test-fixture-home-";
const OWNER_ENV = "OPENRIG_TEST_FIXTURE_REGISTRY_OWNER";
const ownsRegistry = () => process.env[OWNER_ENV] === String(process.pid);

export function setup(): void {
  if (ownsRegistry() && process.env[FIXTURE_REGISTRY_ENV] && fs.existsSync(process.env[FIXTURE_REGISTRY_ENV]!)) return;
  process.env[FIXTURE_REGISTRY_ENV] = fs.mkdtempSync(path.join(os.tmpdir(), ".openrig-test-fixture-registry-"));
  process.env[OWNER_ENV] = String(process.pid);
}

export function teardown(): void {
  const registry = process.env[FIXTURE_REGISTRY_ENV];
  if (!ownsRegistry() || !registry || !fs.existsSync(registry)) return;
  for (const entry of fs.readdirSync(registry)) {
    let home = "";
    try { home = fs.readFileSync(path.join(registry, entry), "utf8"); } catch { continue; }
    // Only paths this suite names as fixture homes are ever removed, whatever a registry file says.
    if (!path.basename(home).startsWith(FIXTURE_HOME_PREFIX)) continue;
    for (const dir of [home, `${home}-user-home`]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
  try { fs.rmSync(registry, { recursive: true, force: true }); } catch { /* best effort */ }
  delete process.env[FIXTURE_REGISTRY_ENV];
  delete process.env[OWNER_ENV];
}
