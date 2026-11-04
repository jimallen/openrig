import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { HC_SCRATCH_ROOT_ENV } from "./hc-scratch.js";
import { prepareHermeticEnv, type HermeticScaffold, type PrepareHermeticEnvOptions } from "./hermetic-env.js";

/** A folder a run names (absolute, outside every temp location) for scaffolds the production trust check must accept. */
export const TRUSTED_BASE_ENV = "OPENRIG_TEST_TRUSTED_BASE";

export class TrustedBaseRefusedError extends Error {
  constructor(reason: string) {
    super(`trusted scaffold refused: ${reason}. The production trust check refuses every temp location, so this scaffold cannot live in a ` +
      `contained run's temp root; set ${TRUSTED_BASE_ENV} to an absolute folder outside temp that the run owns. Nothing was created.`);
    this.name = "TrustedBaseRefusedError";
  }
}

/**
 * The name of the one folder an uncontained run makes for its scaffolds (see `defaultTrustedRunRoot`): `<prefix><pid>-XXXXXX`. The
 * creating process's pid is in the name so that `sweepAbandonedRunRoots` can tell a folder whose run is gone from one still in use.
 * Folders made before the pid was added are `<prefix>XXXXXX` and are never matched by the sweep (see `RUN_ROOT_NAME`).
 */
export const TRUSTED_RUN_ROOT_PREFIX = ".openrig-test-run-";

type EnvLike = Record<string, string | undefined>;
type OnExit = (cleanup: () => void) => void;
const removeOnProcessExit: OnExit = (cleanup) => { process.once("exit", cleanup); };
const runRoots = new Map<string, string>();

/**
 * Remove every run root this process made. The removal used to hang only on `process.once("exit")`, which does NOT fire in a vitest
 * worker (measured on Sparky, vitest 3.2.4, one passing test that made a root: the forks worker got SIGTERM and ended with no
 * 'exit' event, and the threads worker ended with none either), so every run left one empty root in the account's home. The daemon
 * suite's setup file (`trusted-run-root.setup.ts`) calls this from an `afterAll`, which runs in the worker, like the fixture-home
 * removal in test/hermetic-env.setup.ts (OF-80). Safe to call twice; the root is made again on next use.
 */
export function removeTrustedRunRoots(): void {
  for (const [home, root] of [...runRoots]) {
    runRoots.delete(home);
    rmSync(root, { recursive: true, force: true });
  }
}

/** `<prefix><pid>-XXXXXX` exactly (mkdtemp's six characters are [A-Za-z0-9]); anything else, the old `<prefix>XXXXXX` included, is not ours to sweep. */
const RUN_ROOT_NAME = new RegExp(`^${TRUSTED_RUN_ROOT_PREFIX.replace(/\./g, "\\.")}(\\d+)-[A-Za-z0-9]{6}$`);

const pidIsAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } // EPERM: it exists, it is not ours: alive
};

/**
 * A SIGKILLed run (or a worker killed before its `afterAll`) cannot remove its root, so the next run sweeps what it left. The sweep
 * removes a folder only when ALL hold: its name is exactly `<prefix><pid>-XXXXXX`; it is a real directory (lstat, not a link) owned by
 * this user; the pid in the name is not a live process; and it is EMPTY. The removal is `rmdir`, which refuses a non-empty folder, so
 * a root that still holds a scaffold is never touched. A root whose creator's pid was reused by a live process is kept (the safe
 * direction). Returns the names removed. `isAlive` is a seam for the test.
 */
export function sweepAbandonedRunRoots(home: string, isAlive: (pid: number) => boolean = pidIsAlive): string[] {
  const removed: string[] = [];
  const uid = process.getuid?.();
  for (const name of readdirSync(home)) {
    const match = RUN_ROOT_NAME.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || isAlive(pid)) continue;
    const path = join(home, name);
    try {
      const st = lstatSync(path);
      if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) continue;
      rmdirSync(path); // never recursive: a non-empty root throws ENOTEMPTY and stays
      removed.push(name);
    } catch { /* gone already, or not empty, or not ours: leave it */ }
  }
  return removed;
}

/**
 * The default trusted base of a run that names none and whose HOME is a temp fixture. The trust check refuses every temp location, so it
 * is outside temp, in the account's home: ONE folder (`<home>/.openrig-test-run-<pid>-XXXXXX`, 0700), made on first use and removed, with every
 * scaffold inside it, by `removeTrustedRunRoots` (the daemon suite's per-file `afterAll`) or, for a non-vitest process, when the process
 * exits. Scaffolds were made straight in the account's home before, and a run left them there. Making a root also sweeps the empty roots
 * of runs that are gone (`sweepAbandonedRunRoots`).
 */
function defaultTrustedRunRoot(accountHome: () => string, onExit: OnExit): string {
  const home = accountHome();
  const known = runRoots.get(home);
  if (known && existsSync(known)) return known;
  if (!isAbsolute(home) || underTempRoot(home, process.env)) throw new TrustedBaseRefusedError("the account home is not an absolute folder outside temp");
  try { sweepAbandonedRunRoots(home); } catch { /* the sweep is housekeeping; a home that cannot be listed must not stop a run */ }
  const root = mkdtempSync(join(home, `${TRUSTED_RUN_ROOT_PREFIX}${process.pid}-`));
  chmodSync(root, 0o700);
  runRoots.set(home, root);
  onExit(() => { runRoots.delete(home); rmSync(root, { recursive: true, force: true }); });
  return root;
}

/** realpath of the nearest existing ancestor, then the rest as written (macOS links /tmp into /private, and the path may not exist yet). */
const real = (p: string): string => {
  for (let head = p, tail = ""; ; tail = join(basename(head), tail), head = dirname(head)) {
    try { return join(realpathSync(head), tail); } catch { /* try the parent */ }
    if (dirname(head) === head) return p;
  }
};
const underTempRoot = (path: string, env: EnvLike): boolean =>
  ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders", tmpdir(), env.TMPDIR ?? ""].filter(Boolean).some((root) => {
    const rel = relative(real(root), real(path));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });

/**
 * The folder a trusted scaffold is made in. In order: `OPENRIG_TEST_TRUSTED_BASE` when the run names one; the run's own HOME when
 * it is outside every temp location; else, when the run declares itself contained (`OPENRIG_TEST_SCRATCH_ROOT` is set), a refusal,
 * because the only other answer is the account's real home, which a contained run must never reach; else the run root `defaultTrustedRunRoot` makes in the account's home
 * (an uncontained run's HOME is a temp fixture, which the trust check refuses). `accountHome` is a seam for the test.
 */
export function trustedBaseFolder(env: EnvLike = process.env, accountHome: () => string = () => userInfo().homedir, onExit: OnExit = removeOnProcessExit): string {
  const named = env[TRUSTED_BASE_ENV];
  if (named) {
    if (!isAbsolute(named) || !existsSync(named)) throw new TrustedBaseRefusedError(`${TRUSTED_BASE_ENV} is not an existing absolute folder`);
    if (underTempRoot(named, env)) throw new TrustedBaseRefusedError(`${TRUSTED_BASE_ENV} is inside a temp location`);
    return named;
  }
  const home = env.HOME;
  if (home && isAbsolute(home) && !underTempRoot(home, env)) return home;
  if (env[HC_SCRATCH_ROOT_ENV]) throw new TrustedBaseRefusedError("this run is contained and its HOME is in temp");
  return defaultTrustedRunRoot(accountHome, onExit);
}

/** A new folder `<prefix>XXXXXX` inside `trustedBaseFolder()`. */
export function makeTrustedBase(prefix: string, env: EnvLike = process.env): string {
  return mkdtempSync(join(trustedBaseFolder(env), prefix));
}

/**
 * OF-103. A real daemon judges a rig's recorded spec source again at every fresh launch and restore (the production trust
 * check: under a trusted spec root by its real location, not in a temp folder or git work tree, owned by the user and not
 * writable by group or others along the whole chain). A scenario spec inside the repository checkout is a git work tree, so
 * a test that does `rig up <repo>/packages/test-system/scenarios/x.yaml` and then launches a seat fresh is refused with
 * startup_source_untrusted. Such a test builds its scaffold with this helper and brings its spec in with
 * `installTrustedScenario`; the daemon itself gets no test-only bypass.
 *
 * The scaffold root is made by `trustedBaseFolder()`: the run's trusted base, its HOME when that is outside temp, else the account's
 * home folder (the runner points HOME at a temp fixture, so the account database is asked; a contained run refuses instead), because the production rule refuses every temp location; the daemon's own HOME is the scaffold's
 * `home`, whose `.agents-release` is a trusted root. The scaffold is removed with its base by `cleanup()`.
 */
export function prepareTrustedHermeticEnv(opts: PrepareHermeticEnvOptions = {}): HermeticScaffold {
  const base = makeTrustedBase(".of103-e2e-");
  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = base;
  let scaffold: HermeticScaffold;
  try { scaffold = prepareHermeticEnv(opts); }
  catch (err) { rmSync(base, { recursive: true, force: true }); throw err; }
  finally { if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp; }
  // The folders on the spec's chain must not be group- or other-writable whatever the umask.
  for (const dir of [scaffold.root, scaffold.home, scaffold.openrigHome]) chmodSync(dir, 0o755);
  const inner = scaffold.cleanup;
  // The scaffold lives inside `base`: when its cleanup throws (its tmux server could not be verified stopped), both are kept.
  scaffold.cleanup = () => { inner(); rmSync(base, { recursive: true, force: true }); };
  return scaffold;
}

/** Make `dir` and every folder below `stop` 0755, files 0644 (0755 when executable), so the trust check accepts the tree. */
function normalizeModes(path: string, stop: string): void {
  for (let d = dirname(path); d.length > stop.length; d = dirname(d)) chmodSync(d, 0o755);
  const walk = (p: string) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) { chmodSync(p, 0o755); for (const name of readdirSync(p)) walk(join(p, name)); }
    else chmodSync(p, (st.mode & 0o111) !== 0 ? 0o755 : 0o644);
  };
  walk(path);
}

/**
 * Copy a repository scenario (its yaml, the `culture.md` and the `agents/` tree beside it, which its relative refs need)
 * into `<scaffold HOME>/.agents-release/scenarios/`, a trusted spec root of the daemon the scaffold spawns, and return the
 * copied yaml's path. Use it as the spec path of `rig up`.
 */
export function installTrustedScenario(scaffold: HermeticScaffold, scenarioYaml: string): string {
  const src = dirname(scenarioYaml);
  const home = realpathSync(scaffold.home);
  const dest = join(home, ".agents-release", "scenarios");
  mkdirSync(dest, { recursive: true });
  cpSync(scenarioYaml, join(dest, basename(scenarioYaml)));
  cpSync(join(src, "culture.md"), join(dest, "culture.md"));
  cpSync(join(src, "agents"), join(dest, "agents"), { recursive: true });
  normalizeModes(join(dest, basename(scenarioYaml)), realpathSync(scaffold.root));
  normalizeModes(join(dest, "culture.md"), realpathSync(scaffold.root));
  normalizeModes(join(dest, "agents"), realpathSync(scaffold.root));
  return join(dest, basename(scenarioYaml));
}
