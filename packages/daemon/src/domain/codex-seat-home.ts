import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * OPR-fork: codex seats must NOT share one ~/.codex app-server environment.
 *
 * Codex's managed app-server is a singleton PER CODEX_HOME: the first TUI in a
 * home spawns it, and its environment (including our OPENRIG_* seat-identity
 * stamps) freezes with that first launcher. Every later codex TUI in the same
 * home runs its agent shell tools with the FIRST seat's env — so
 * `rig whoami` / `rig send` inside a codex seat resolve identity env-first
 * (whoami steps 3/4) to a foreign seat (measured live: a verify seat resolved
 * as queue-worker@kernel via resolvedBy=node_id on codex 0.158.0).
 *
 * Fix: each codex seat launches with CODEX_HOME set to a per-seat home. The
 * codex harness and its managed app-server then freeze the RIGHT seat's env.
 * The seat home shares the operator's account material by symlink (auth,
 * config incl. project trust state, packages, skills) and COPIES profile
 * fragments: a copied <profile>.config.toml canonicalizes to a per-seat path,
 * keeping codex resume key_source distinct per seat instead of collapsing all
 * seats onto the shared profile path.
 */

const SYMLINKED_ENTRIES = [
  "auth.json",
  "config.toml",
  "AGENTS.md",
  "plugins",
  "rules",
  "skills",
  "shell_snapshots",
  "mcp-oauth-locks",
] as const;

// `packages` is deliberately NOT symlinked wholesale: codex's app-server
// management mutates `packages/app-server-daemon/current` (absolute link). If
// every seat home shared the packages dir, each daemon install would repoint
// the link INTO the last-installed seat's home — observed live: a test-run
// seat home was later deleted and the shared current dangled, breaking daemon
// startup for every other seat. Instead each seat gets a REAL packages dir:
// releases are symlinked (the heavy payload, immutable), and `current` is an
// absolute link rooted INSIDE the seat home (through the releases symlink).

export interface CodexSeatHome {
  /** The per-seat CODEX_HOME directory (…/codex-seats/<sanitized session>). */
  path: string;
  linked: string[];
  copiedProfiles: string[];
}

export function sanitizeSessionForPath(sessionName: string): string {
  // tmux session names are already constrained (letters/digits/._-);
  // keep `@` for readability (exec-cos@jims-team), defend the rest.
  return sessionName.replace(/[^A-Za-z0-9._@-]+/g, "_");
}

export function codexSeatHomePath(openrigHome: string, sessionName: string): string {
  return path.join(openrigHome, "codex-seats", sanitizeSessionForPath(sessionName));
}

async function linkIfMissing(source: string, dest: string): Promise<boolean> {
  try {
    await fs.lstat(dest);
    return false; // already present — never overwrite a working seat home
  } catch {
    await fs.symlink(source, dest);
    return true;
  }
}

/**
 * Per-seat packages dir: shared everything EXCEPT the app-server-daemon
 * management state. `current` is rooted inside the seat home so one seat's
 * daemon install/update can never repoint a link another seat depends on.
 * Returns labels of seats-linked entries for reporting.
 */
async function seedSeatPackages(home: string, shared: string): Promise<string[]> {
  const sharedPkgs = path.join(shared, "packages");
  const sharedAsd = path.join(sharedPkgs, "app-server-daemon");
  const linked: string[] = [];
  try {
    await fs.lstat(path.join(sharedAsd, "releases"));
  } catch {
    return linked; // no managed daemon on the shared home — nothing to seed
  }
  const seatPkgs = path.join(home, "packages");
  const seatAsd = path.join(seatPkgs, "app-server-daemon");
  await fs.mkdir(seatAsd, { recursive: true });

  // heavy, immutable payload: one directory, one link
  if (await linkIfMissing(path.join(sharedAsd, "releases"), path.join(seatAsd, "releases")))
    linked.push("packages/app-server-daemon/releases");

  // small mutable housekeeping: copied so one seat's update never writes the
  // shared file
  for (const small of ["auto-update-version"] as const) {
    const src = path.join(sharedAsd, small);
    const dest = path.join(seatAsd, small);
    try {
      await fs.copyFile(src, dest);
      linked.push(`packages/app-server-daemon/${small}`);
    } catch {
      // absent — fine
    }
  }

  // `current`: absolute, rooted INSIDE the seat home (via its releases link).
  // Version source of truth: the shared current link if it resolves, else the
  // newest release dir.
  let version: string | null = null;
  try {
    const sharedCurrent = await fs.readlink(path.join(sharedAsd, "current"));
    const byName = path.basename(sharedCurrent);
    await fs.lstat(path.join(sharedAsd, "releases", byName));
    version = byName;
  } catch {
    const releases = await fs.readdir(path.join(sharedAsd, "releases")).catch(() => []);
    version = releases.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop() ?? null;
  }
  if (version) {
    const dest = path.join(seatAsd, "current");
    try {
      await fs.lstat(dest);
    } catch {
      await fs.symlink(path.join(seatAsd, "releases", version), dest);
      linked.push("packages/app-server-daemon/current");
    }
  }

  // every other top-level packages entry links straight through
  const otherPkgs = await fs.readdir(sharedPkgs).catch(() => [] as string[]);
  for (const entry of otherPkgs) {
    if (entry === "app-server-daemon") continue;
    const src = path.join(sharedPkgs, entry);
    if (await linkIfMissing(src, path.join(seatPkgs, entry)))
      linked.push(`packages/${entry}`);
  }
  return linked;
}

/**
 * Create (idempotently) the per-seat codex home under
 * `<openrigHome>/codex-seats/<session>` seeded from the shared codex home.
 * Missing shared entries are skipped (a minimal codex install still works;
 * codex creates its own session/state files inside the home).
 */
export async function ensureCodexSeatHome(
  sessionName: string,
  opts?: { openrigHome?: string; sharedCodexHome?: string },
): Promise<CodexSeatHome> {
  const openrigHome = opts?.openrigHome ?? process.env["OPENRIG_HOME"] ?? path.join(os.homedir(), ".openrig");
  const shared = opts?.sharedCodexHome ?? process.env["CODEX_HOME_DEFAULT"] ?? path.join(os.homedir(), ".codex");
  const home = codexSeatHomePath(openrigHome, sessionName);

  await fs.mkdir(home, { recursive: true });

  const linked: string[] = [];
  for (const entry of SYMLINKED_ENTRIES) {
    const source = path.join(shared, entry);
    try {
      await fs.lstat(source);
    } catch {
      continue; // absent on the shared home — skip silently
    }
    const dest = path.join(home, entry);
    if (await linkIfMissing(source, dest)) linked.push(entry);
  }
  linked.push(...(await seedSeatPackages(home, shared)));

  // Profile fragments are COPIED (see module doc): per-seat canonical path,
  // per-seat identity edits stay seat-local.
  const copiedProfiles: string[] = [];
  let entries: string[] = [];
  try {
    entries = await fs.readdir(shared);
  } catch {
    // no shared codex home at all — the seat home exists but is empty;
    // codex will bootstrap it.
  }
  for (const entry of entries) {
    if (!entry.endsWith(".config.toml")) continue;
    const source = path.join(shared, entry);
    const stat = await fs.lstat(source).catch(() => null);
    if (!stat?.isFile()) continue;
    const dest = path.join(home, entry);
    try {
      await fs.lstat(dest);
    } catch {
      await fs.copyFile(source, dest);
      copiedProfiles.push(entry);
    }
  }

  return { path: home, linked, copiedProfiles };
}
