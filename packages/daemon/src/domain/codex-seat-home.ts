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
  "packages",
  "plugins",
  "rules",
  "skills",
  "shell_snapshots",
  "mcp-oauth-locks",
] as const;

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
