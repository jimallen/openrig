// Tripwire for private hc cores (hc cutover, package W8; census-hc-tmux section 4, layer 2, adapted to hc).
//
// A test that needs a core starts one through `packages/daemon/test/helpers/hc-scratch.ts`: a short root
// `<base>/hcs-xxxxxx` holding the core's HOME, XDG paths and socket. `cleanup()` removes that root only AFTER it
// verified the core, its holders and its terminal programs are gone, and throws, keeping the root, when it cannot. So a
// root that is still on disk when the run ends means a test never cleaned up or cleanup could not verify. This module
// finds those roots at the end of the run (hermetic-env.global.ts `teardown`), so a leaked private core is a red run,
// not a quiet process on the machine.
//
// Which roots are this run's (W20). The run's main process makes a REGISTRY directory (`setup`, the same place that makes
// the fixture-home registry) and publishes it in OPENRIG_TEST_HC_SCRATCH_REGISTRY, which the workers inherit. Every
// `startHcScratch` writes one file there naming its root (and the test file that asked for it) BEFORE it creates anything
// else. `teardown` then looks at exactly those roots. It used to scan /tmp for `hcs-*` directories born since the run
// started and try to tell its own from a concurrent run's by the orphan guards' argv; that guess tripped on a neighbour's
// root in the window between `mkdtemp` and the guard being armed, and on any root of this run's other workers when
// the scan ran inside a worker (test/fixture-home-cleanup.test.ts calls `teardown()` in process). A registry has no
// neighbours and no window: a root is in it, or it is not this run's.
//
// What it does not do, stated here as the other hermetic guards state theirs:
//  - It reports; it kills nothing and removes nothing. The orphan guard armed by hc-scratch is what reaps, and the
//    leftover root is the evidence.
//  - It sees only roots made through `startHcScratch` (every `baseDir` included). A test that makes a root by hand is
//    outside this net, and so is a run with no global setup (a bare vitest of one file has no registry: nothing registers).
//  - A run killed outright (SIGKILL on the main process) never reaches `teardown`; its roots stay on disk as evidence.
//  - Only the process that created the registry reads it. A vitest started from inside a test inherits the variables and
//    sees another owner pid, so it makes its own registry and never reads (or removes) the outer run's.

import fs from "node:fs";
import path from "node:path";

export const HC_SCRATCH_REGISTRY_ENV = "OPENRIG_TEST_HC_SCRATCH_REGISTRY";
/** The pid of the main process that created the registry; any other process holding the variables is not its owner. */
export const HC_SCRATCH_REGISTRY_OWNER_ENV = "OPENRIG_TEST_HC_SCRATCH_REGISTRY_OWNER";

type EnvLike = Record<string, string | undefined>;

/** Whether `pid`'s process made the registry named in `env`. */
export const ownsHcScratchRegistry = (env: EnvLike = process.env, pid: number = process.pid): boolean =>
  !!env[HC_SCRATCH_REGISTRY_ENV] && env[HC_SCRATCH_REGISTRY_OWNER_ENV] === String(pid);

/** Make the registry for this process, unless it already owns a live one. Returns its path. */
export function createHcScratchRegistry(env: EnvLike = process.env, tmp: string): string {
  const existing = env[HC_SCRATCH_REGISTRY_ENV];
  if (existing && ownsHcScratchRegistry(env) && fs.existsSync(existing)) return existing;
  const registry = fs.mkdtempSync(path.join(tmp, ".openrig-test-hc-registry-"));
  env[HC_SCRATCH_REGISTRY_ENV] = registry;
  env[HC_SCRATCH_REGISTRY_OWNER_ENV] = String(process.pid);
  return registry;
}

/**
 * Record a scratch root in the run's registry (a no-op without one). Called by `startHcScratch` right after it created the
 * root, so every root it ever made is on the list whatever happens next. `test` names the asking test file, for the report.
 */
export function registerHcScratchRoot(root: string, test: string | undefined, env: EnvLike = process.env): void {
  const registry = env[HC_SCRATCH_REGISTRY_ENV];
  if (!registry || !fs.existsSync(registry)) return;
  fs.writeFileSync(path.join(registry, path.basename(root)), JSON.stringify({ root, test: test ?? null }));
}

export interface LeakedHcScratch {
  root: string;
  /** The test file that asked for the root, when it was known. */
  test: string | null;
}

/** Every registered root that is still on disk. A registry that cannot be read throws: a guard that cannot look must not report clean. */
export function findLeakedHcScratch(registry: string): LeakedHcScratch[] {
  const leaked: LeakedHcScratch[] = [];
  for (const entry of fs.readdirSync(registry).sort()) {
    const recorded = JSON.parse(fs.readFileSync(path.join(registry, entry), "utf8")) as { root?: unknown; test?: unknown };
    if (typeof recorded.root !== "string") throw new Error(`hc scratch tripwire: registry entry ${entry} names no root`);
    if (fs.existsSync(recorded.root)) leaked.push({ root: recorded.root, test: typeof recorded.test === "string" ? recorded.test : null });
  }
  return leaked;
}

export function describeLeak(leaked: LeakedHcScratch[]): string {
  const named = leaked.map((l) => (l.test ? `${l.root} (asked for by ${l.test})` : l.root));
  return (
    `hc scratch tripwire: ${leaked.length} private hc core root(s) were left behind by this run: ` +
    `${named.join(", ")}. hc-scratch removes its root only after it verified the core stopped, so a test did not ` +
    `call cleanup() or cleanup could not verify. A core may still be running (its HC_SESSION is s + the last six characters ` +
    `of the directory name); the orphan guard reaps it when its owner dies, the root is kept as evidence.`
  );
}
