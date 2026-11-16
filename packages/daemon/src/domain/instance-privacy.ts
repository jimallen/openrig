import { join, relative, isAbsolute, sep } from "node:path";

/**
 * Instance privacy (workspaces-o9o.36). Invariant, owned by the OpenRig instance:
 *
 *   An OpenRig instance is private to its owner. Its home is 0700, and nothing under it grants group or other
 *   access.
 *
 * A seat's conversation (Pi session files, Codex rollouts, pane transcripts) holds full tool output, secrets
 * included. Every OpenRig process runs under the login umask (0002 on Ubuntu), and more than a hundred writers
 * create files under the home with the default mode, so the invariant is kept at the container: every start
 * removes group and other bits from the home and everything below it. Owner bits are kept, so an executable the
 * owner runs (rig-bin/git, a handover release.sh) stays executable.
 *
 * Two boundaries, each pinned: a symlink is never followed (its target lives outside the instance and is not
 * ours to change), and nothing outside the home is ever walked. A home that is the user's own home directory,
 * or an ancestor of it, is not an instance home: it is never walked.
 */

export type InstanceEntryKind = "directory" | "file" | "symlink" | "other";

/** Outbound port: what the privacy rule needs from the filesystem. */
export interface InstancePrivacyPort {
  /** The user's home directory; a home equal to it or above it is refused. */
  readonly userHome: string;
  /** The entry itself, never its symlink target (lstat); null when it does not exist. */
  entry(path: string): { kind: InstanceEntryKind; mode: number } | null;
  /** The names in a directory. */
  list(dir: string): string[];
  chmod(path: string, mode: number): void;
}

export interface InstancePrivacyResult {
  /** "refused" when the home is the user's home or an ancestor of it, "missing" when it does not exist. */
  status: "secured" | "refused" | "missing";
  tightened: number;
  failures: Array<{ path: string; error: string }>;
}

/** Group and other bits. */
const SHARED_BITS = 0o077;

function isSameOrAncestor(candidate: string, of: string): boolean {
  const rel = relative(candidate, of);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Keep the instance private to its owner: remove group and other access from the home and everything below it. */
export function secureInstanceHome(home: string, port: InstancePrivacyPort): InstancePrivacyResult {
  const result: InstancePrivacyResult = { status: "secured", tightened: 0, failures: [] };
  if (isSameOrAncestor(home, port.userHome)) return { ...result, status: "refused" };
  const root = port.entry(home);
  if (!root || root.kind !== "directory") return { ...result, status: "missing" };

  const tighten = (path: string, mode: number): void => {
    if ((mode & SHARED_BITS) === 0) return;
    try {
      port.chmod(path, mode & 0o700);
      result.tightened += 1;
    } catch (err) {
      result.failures.push({ path, error: (err as Error).message });
    }
  };

  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = port.list(dir);
    } catch (err) {
      result.failures.push({ path: dir, error: (err as Error).message });
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      const entry = port.entry(path);
      if (!entry) continue;
      if (entry.kind === "file") tighten(path, entry.mode);
      else if (entry.kind === "directory") {
        tighten(path, entry.mode);
        walk(path);
      }
      // symlink: never followed, and its target never changed. other (socket, fifo): unreachable inside a 0700 home.
    }
  };

  tighten(home, root.mode);
  walk(home);
  return result;
}
