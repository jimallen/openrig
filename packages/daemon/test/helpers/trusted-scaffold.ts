import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { prepareHermeticEnv, type HermeticScaffold, type PrepareHermeticEnvOptions } from "./hermetic-env.js";

/**
 * OF-103. A real daemon judges a rig's recorded spec source again at every fresh launch and restore (the production trust
 * check: under a trusted spec root by its real location, not in a temp folder or git work tree, owned by the user and not
 * writable by group or others along the whole chain). A scenario spec inside the repository checkout is a git work tree, so
 * a test that does `rig up <repo>/packages/test-system/scenarios/x.yaml` and then launches a seat fresh is refused with
 * startup_source_untrusted. Such a test builds its scaffold with this helper and brings its spec in with
 * `installTrustedScenario`; the daemon itself gets no test-only bypass.
 *
 * The scaffold root is made under the account's real home folder (the runner points HOME at a temp fixture, so the account
 * database is asked), because the production rule refuses every temp location; the daemon's own HOME is the scaffold's
 * `home`, whose `.agents-release` is a trusted root. The scaffold is removed with its base by `cleanup()`.
 */
export function prepareTrustedHermeticEnv(opts: PrepareHermeticEnvOptions = {}): HermeticScaffold {
  const base = mkdtempSync(join(userInfo().homedir, ".of103-e2e-"));
  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = base;
  let scaffold: HermeticScaffold;
  try { scaffold = prepareHermeticEnv(opts); }
  catch (err) { rmSync(base, { recursive: true, force: true }); throw err; }
  finally { if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp; }
  // The folders on the spec's chain must not be group- or other-writable whatever the umask.
  for (const dir of [scaffold.root, scaffold.home, scaffold.openrigHome]) chmodSync(dir, 0o755);
  const inner = scaffold.cleanup;
  scaffold.cleanup = () => { try { inner(); } finally { rmSync(base, { recursive: true, force: true }); } };
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
