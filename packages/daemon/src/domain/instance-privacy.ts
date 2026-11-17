import { basename, dirname, join, relative, resolve, isAbsolute, sep } from "node:path";

/**
 * Instance privacy (workspaces-o9o.36). Invariant, owned by the OpenRig instance:
 *
 *   An OpenRig instance is private to its owner: its home is 0700, so nothing under it is reachable by another
 *   user, whatever the modes below it. A transcripts root configured outside the home is kept the same way.
 *
 * Every start also removes group and other bits from everything under a private root. A few writers restore a
 * public mode afterwards, and that is harmless inside the 0700 home: vendored plugin copies take their package
 * source's mode (plugin-vendor-service, the Codex and Pi adapters) and the built-in policy reference is re-pinned
 * 0444.
 *
 * A seat's conversation (Pi session files, Codex rollouts, pane transcripts) holds full tool output, secrets
 * included. Every OpenRig process runs under the login umask (0002 on Ubuntu), and more than a hundred writers
 * create files under the home with the default mode, so the invariant is kept at the container: every start
 * sets the root to exactly 0700 (a root its owner cannot enter, such as 0600, is opened to 0700) and removes group
 * and other bits from everything below it. Owner bits below the root are kept, so an executable the owner runs
 * (rig-bin/git, a handover release.sh) stays executable.
 *
 * Boundaries, each pinned:
 * - A private root that is the user's own home directory or an ancestor of it is refused, and the refusal comes
 *   before anything is written. It is judged on real paths as well as the paths given, so a symlinked alias of the
 *   home, or of one of its ancestors, is refused too.
 * - A symlink below the root is never followed (its target is not ours to change), and nothing outside the root is
 *   ever walked.
 *
 * Residual, accepted on 2026-11-16 under the same-user threat model: first for o9o.17 by OpenRig's 15-minute auto-answer
 * (queue record qa-f5c084b1679e94516e44aff1e88a8361, which took the Recommended option under Jim's rule of 2026-11-08),
 * then confirmed for o9o.36 by Jim's own modal answer at 20:03Z. The window: an entry, or an
 * ancestor directory, swapped for a symlink between the lstat that classifies it and the chmod that follows. Node
 * has no fchmodat with AT_SYMLINK_NOFOLLOW and no openat on a directory handle, so the window cannot be closed
 * here. Precondition: a concurrent process running as the same user, writing inside the private root during that
 * window; such a process is outside the threat model, since it can already read and change those files directly.
 */

export type InstanceEntryKind = "directory" | "file" | "symlink" | "other";

/** Outbound port: what the privacy rule needs from the filesystem. */
export interface InstancePrivacyPort {
  /** The user's home directory; a private root equal to it or above it is refused. */
  readonly userHome: string;
  /** The entry itself, never its symlink target (lstat); null when it does not exist. */
  entry(path: string): { kind: InstanceEntryKind; mode: number } | null;
  /** The path with every symlink resolved; a part that does not exist yet is kept as given. */
  realPath(path: string): string;
  /** The names in a directory. */
  list(dir: string): string[];
  chmod(path: string, mode: number): void;
}

export interface InstancePrivacyResult {
  /** "refused" when the root is the user's home or an ancestor of it, "missing" when it is not a directory. */
  status: "secured" | "refused" | "missing";
  tightened: number;
  failures: Array<{ path: string; error: string }>;
}

/** Group and other bits. */
const SHARED_BITS = 0o077;
const PRIVATE_DIR = 0o700;

function isSameOrAncestor(candidate: string, of: string): boolean {
  const rel = relative(candidate, of);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Why a path may not be a private root, or null when it may. The user's home and its ancestors are refused,
 * compared both as given and with every symlink resolved. */
export function privateRootRefusal(root: string, port: InstancePrivacyPort): string | null {
  const roots = new Set([resolve(root), port.realPath(root)]);
  const homes = new Set([resolve(port.userHome), port.realPath(port.userHome)]);
  for (const candidate of roots) {
    for (const home of homes) {
      if (isSameOrAncestor(candidate, home)) {
        return `${root} is the user's home directory ${port.userHome} or an ancestor of it`;
      }
    }
  }
  return null;
}

/** Open a root its owner cannot use, or that others can reach, to exactly 0700. */
function setRootPrivate(root: string, mode: number, port: InstancePrivacyPort, result: InstancePrivacyResult): void {
  if (mode === PRIVATE_DIR) return;
  try {
    port.chmod(root, PRIVATE_DIR);
    result.tightened += 1;
  } catch (err) {
    result.failures.push({ path: root, error: (err as Error).message });
  }
}

/** Make only the root itself 0700, before anything is written into it. */
export function openPrivateRoot(root: string, port: InstancePrivacyPort): InstancePrivacyResult {
  const result: InstancePrivacyResult = { status: "secured", tightened: 0, failures: [] };
  if (privateRootRefusal(root, port)) return { ...result, status: "refused" };
  const entry = port.entry(root);
  if (!entry || entry.kind !== "directory") return { ...result, status: "missing" };
  setRootPrivate(root, entry.mode, port, result);
  return result;
}

/** Keep a private root private to its owner: the root 0700, and group and other access removed from everything
 * below it. */
export function securePrivateRoot(root: string, port: InstancePrivacyPort): InstancePrivacyResult {
  const result: InstancePrivacyResult = { status: "secured", tightened: 0, failures: [] };
  if (privateRootRefusal(root, port)) return { ...result, status: "refused" };
  const rootEntry = port.entry(root);
  if (!rootEntry || rootEntry.kind !== "directory") return { ...result, status: "missing" };

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
      // symlink: never followed, and its target never changed. other (socket, fifo): unreachable inside a 0700 root.
    }
  };

  setRootPrivate(root, rootEntry.mode, port, result);
  walk(root);
  return result;
}

/** The files SQLite keeps beside a database. */
const DB_SIDECARS = ["-wal", "-shm", "-journal"];

export interface PrivateDbResult extends InstancePrivacyResult {
  /** `secured`: the folder is OpenRig's own and is 0700. `shared`: it holds other things and was left as it is (`others` names them).
   *  `refused`: it is the user's home or above it. `missing`: it does not exist. */
  folder: "secured" | "shared" | "refused" | "missing";
  others?: string[];
}

/**
 * Keep a database configured outside the OpenRig home private to its owner (workspaces-o9o.74). Unlike a transcripts root, the db's
 * folder is not necessarily OpenRig's: db.path may name a file in a shared folder (~/Documents/openrig.sqlite). So:
 * - the db and its SQLite sidecars are made 0600 (lstat; a symlink is never followed; a missing file is skipped);
 * - the folder is made exactly 0700 only when it is OpenRig's own: it holds nothing but those files (an empty folder, as the preflight
 *   leaves it before the first start, counts). A folder holding anything else is left as it is and its other entries are named;
 * - a folder that is the user's home or above it is refused;
 * - nothing below the folder is walked.
 */
export function securePrivateDb(dbPath: string, port: InstancePrivacyPort): PrivateDbResult {
  const result: PrivateDbResult = { status: "secured", folder: "secured", tightened: 0, failures: [] };
  const dir = dirname(resolve(dbPath));
  const dirEntry = port.entry(dir);
  if (!dirEntry || dirEntry.kind !== "directory") return { ...result, status: "missing", folder: "missing" };

  const dbFiles = new Set([basename(dbPath), ...DB_SIDECARS.map((suffix) => `${basename(dbPath)}${suffix}`)]);
  for (const name of dbFiles) {
    const path = join(dir, name);
    const entry = port.entry(path);
    if (!entry || entry.kind !== "file" || (entry.mode & SHARED_BITS) === 0) continue;
    try {
      port.chmod(path, entry.mode & 0o700);
      result.tightened += 1;
    } catch (err) {
      result.failures.push({ path, error: (err as Error).message });
    }
  }

  if (privateRootRefusal(dir, port)) return { ...result, folder: "refused" };
  let names: string[];
  try {
    names = port.list(dir);
  } catch (err) {
    result.failures.push({ path: dir, error: (err as Error).message });
    return { ...result, folder: "shared", others: [] };
  }
  const others = names.filter((name) => !dbFiles.has(name));
  if (others.length > 0) return { ...result, folder: "shared", others };
  setRootPrivate(dir, dirEntry.mode, port, result);
  return result;
}
