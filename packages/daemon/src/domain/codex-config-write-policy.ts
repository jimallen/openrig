import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * OF-183: which OpenRig daemon may change a Codex `config.toml`.
 *
 * `~/.codex/config.toml` is host-wide: every Codex seat's CODEX_HOME symlinks it (codex-seat-home.ts), and it holds
 * the top-level OpenRig activity-hook commands plus the `[hooks.state.*] trusted_hash` records of live seats. A
 * second daemon (a scratch or dev build) that upserts it repoints those hooks at ITS build and rewrites live seats'
 * trust records (measured twice on Sparky, 2026-10-30/31, the second time on daemon start with no Codex seat).
 *
 * The rule, fail closed:
 *   - The host's INSTALLED daemon writes as before.
 *   - Any other daemon writes a config file only when that file lives in a home PROVEN private to it. Anything it
 *     cannot prove private is refused, and so is the host's own `<passwd home>/.codex`.
 *
 * "Installed" is read from evidence, never from a flag the caller can set:
 *   (1) the daemon's code lives in the npm-install layout `…/node_modules/@openrig/cli/daemon` (a checkout or a
 *       worktree build is `packages/daemon`), whose enclosing package.json names `@openrig/cli`; and
 *   (2) its OPENRIG_HOME is the host's default `<passwd home>/.openrig`, the state directory the installed daemon
 *       owns (a scratch daemon must run on another one or it would collide with the live daemon's database).
 * The passwd home (os.userInfo) is used, not $HOME, because a scratch daemon is typically started with HOME
 * overridden and must not be able to look installed by claiming the real home.
 */

export type CodexConfigWriteDecision = { allowed: true; reason: string } | { allowed: false; reason: string };

export interface CodexConfigWritePolicy {
  /** May this daemon change the Codex config file at `configPath`? Pure: reads only the filesystem metadata. */
  decide(configPath: string): CodexConfigWriteDecision;
}

/** Library-level default: no restriction (unit tests, embedders). The daemon's startup always injects a real policy. */
export const unrestrictedCodexConfigWrites: CodexConfigWritePolicy = {
  decide: () => ({ allowed: true, reason: "no policy installed" }),
};

export interface CodexConfigWritePolicyFacts {
  /** The daemon package root (the directory holding `dist/`). */
  codeRoot: string;
  /** This process's OPENRIG_HOME as it resolves. */
  openrigHome: string;
  /** The account's home directory from the passwd entry, or null when it cannot be read. */
  hostHome: string | null;
  /** This process's $HOME as os.homedir() reports it. */
  processHome: string;
  /** `name` of the package.json at `dir`, undefined when absent or unreadable. */
  readPackageName: (dir: string) => string | undefined;
  /** Canonicalize `p`; the nearest existing ancestor is resolved when `p` does not exist yet. */
  canonicalize: (p: string) => string;
  /** The raw target of `p` when `p` itself is a symbolic link (even a dangling one), undefined when it is not one. */
  symlinkTarget?: (p: string) => string | undefined;
}

const isWithin = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export function canonicalizeBestEffort(p: string): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function readPackageNameFromDisk(dir: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

function passwdHome(): string | null {
  try {
    const home = os.userInfo().homedir;
    return home ? home : null;
  } catch {
    return null;
  }
}

/** Why this daemon is, or is not, the host's installed one. */
export function judgeInstalled(facts: CodexConfigWritePolicyFacts): { installed: boolean; reason: string } {
  const root = facts.canonicalize(facts.codeRoot);
  const cliPackage = path.dirname(root);
  const layout = path.basename(root) === "daemon"
    && path.basename(cliPackage) === "cli"
    && path.basename(path.dirname(cliPackage)) === "@openrig"
    && path.basename(path.dirname(path.dirname(cliPackage))) === "node_modules";
  if (!layout) return { installed: false, reason: `code root ${root} is not an npm-installed @openrig/cli daemon` };
  if (facts.readPackageName(cliPackage) !== "@openrig/cli") {
    return { installed: false, reason: `${cliPackage} does not carry the @openrig/cli package manifest` };
  }
  if (facts.hostHome === null) return { installed: false, reason: "the account home directory could not be read" };
  const hostOpenrig = facts.canonicalize(path.join(facts.hostHome, ".openrig"));
  if (facts.canonicalize(facts.openrigHome) !== hostOpenrig) {
    return { installed: false, reason: `OPENRIG_HOME ${facts.canonicalize(facts.openrigHome)} is not the host's ${hostOpenrig}` };
  }
  return { installed: true, reason: `installed daemon at ${root} on the host's default OPENRIG_HOME` };
}

function readSymlinkTargetFromDisk(p: string): string | undefined {
  try {
    return fs.lstatSync(p).isSymbolicLink() ? fs.readlinkSync(p) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where a write to the config FILE `configPath` lands: its directory canonicalized, then the file's own symbolic
 * link (if it is one, dangling or not) followed to its end. null when the chain loops or is implausibly long.
 */
function resolveConfigFile(facts: CodexConfigWritePolicyFacts, configPath: string): string | null {
  const linkTarget = facts.symlinkTarget ?? (() => undefined);
  let p = path.join(facts.canonicalize(path.dirname(configPath)), path.basename(configPath));
  for (let hops = 0; hops < 40; hops++) {
    const target = linkTarget(p);
    if (target === undefined) return p;
    const next = facts.canonicalize(path.resolve(path.dirname(p), target));
    if (next === p) return null;
    p = next;
  }
  return null;
}

export function createCodexConfigWritePolicy(facts: CodexConfigWritePolicyFacts): CodexConfigWritePolicy {
  const judged = judgeInstalled(facts);
  return {
    decide(configPath: string): CodexConfigWriteDecision {
      if (judged.installed) return { allowed: true, reason: judged.reason };
      // The FILE is resolved too: a config.toml that is a symlink into the host-wide home is written through.
      const resolvedFile = resolveConfigFile(facts, configPath);
      if (resolvedFile === null) return refuse("its config.toml is a symbolic link that cannot be resolved");
      const target = path.dirname(resolvedFile);
      const refuse = (why: string): CodexConfigWriteDecision => ({
        allowed: false,
        reason: `${why}; this daemon is not the host's installed OpenRig (${judged.reason}), so it leaves ${configPath} unchanged`,
      });
      if (facts.hostHome === null) {
        // Cannot tell the host's shared home apart: only the daemon's own state home is provably private.
        const own = facts.canonicalize(facts.openrigHome);
        return isWithin(target, own) ? { allowed: true, reason: "inside this daemon's own OPENRIG_HOME" } : refuse("the host's home is unknown");
      }
      const hostCodex = facts.canonicalize(path.join(facts.hostHome, ".codex"));
      if (target === hostCodex) return refuse("it is the host-wide Codex home");
      const own = facts.canonicalize(facts.openrigHome);
      if (isWithin(target, own)) return { allowed: true, reason: "inside this daemon's own OPENRIG_HOME" };
      const proc = facts.canonicalize(facts.processHome);
      const host = facts.canonicalize(facts.hostHome);
      if (proc !== host && isWithin(target, proc)) return { allowed: true, reason: "inside this process's private HOME" };
      return refuse("it is not provably private to this daemon");
    },
  };
}

/**
 * The policy for the daemon's start-up, and the one line saying what it judged and why, so a misjudged install shows
 * at start-up rather than at the first refused write. `moduleDir` is the directory of the start-up module (`dist/`
 * in a build); the code root is its parent.
 */
export function startupCodexConfigWritePolicy(
  moduleDir: string,
  openrigHome: string,
  log: (line: string) => void = (line) => console.log(line),
): CodexConfigWritePolicy {
  const codeRoot = path.resolve(moduleDir, "..");
  const facts: CodexConfigWritePolicyFacts = {
    codeRoot,
    openrigHome,
    hostHome: passwdHome(),
    processHome: os.homedir(),
    readPackageName: readPackageNameFromDisk,
    canonicalize: canonicalizeBestEffort,
    symlinkTarget: readSymlinkTargetFromDisk,
  };
  const judged = judgeInstalled(facts);
  log(`[openrig] codex config write policy: ${judged.installed ? "installed daemon" : "not the installed daemon"} (${judged.reason}); code root ${codeRoot}, OPENRIG_HOME ${openrigHome}, account home ${facts.hostHome ?? "unreadable"}`);
  return createCodexConfigWritePolicy(facts);
}
