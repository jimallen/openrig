// The real-filesystem adapter for the proof source watch's SourceTreeWatcher port (workspaces-o9o.38).
//
// Watching goes through fs.watch. Evidence that a watch is live comes from the kernel, never from the watcher's own
// claim: on Node v22 a recursive fs.watch on Linux is silently dead when no inotify watch can be added (no throw, no
// 'error'), and it reports an entry it could not watch only once a change event arrives. Node arms one inotify watch per
// entry (directories, files, fifos, and symlinks, which the kernel follows; it does not descend a symlinked directory),
// and a file's own watch is what delivers that file's changes (measured: with the directories watched and the file's
// watch failed, editing the file gives no event). So on Linux this adapter lists every entry under a watched tree the
// way Node does and checks each against the watches this process actually holds, read from /proc/self/fdinfo of its
// inotify descriptors. Nothing is written into the watched tree. Other platforms give no such evidence; unwatched()
// returns null there.
//
// workspaces-o9o.133: on Linux this adapter no longer uses Node's recursive fs.watch. Node's recursive arming differs by
// version (measured on sparky, 2026-11-18: 22.23.4 watches every directory and every file; 24.22.3 and 26.13.1 directories
// only), and on 24 and 26 a directory added while no inotify watch can be added makes Node rethrow ENOSPC from its own
// internal handler (node:internal/fs/recursive_watch:177), an uncaught exception that killed the process. So the adapter
// arms one NON-recursive watch per real directory itself (a directory's inotify watch delivers the events of the entries
// in it, so an ordinary file needs no watch of its own), plus one per symlink (the kernel follows it to its target,
// whose edits no directory watch here would see; a symlinked directory is not descended, as Node did not), arms each
// directory or symlink that appears, drops its watches when it goes (so one re-created is armed again), and catches every
// failure itself: an entry it cannot arm is left unwatched, never thrown, and the evidence below names it. Evidence and
// behaviour are then the same on every Node version: directories and symlinks.
//
// An entry that is gone (removed since the listing, or a dangling symlink: ENOENT, ENOTDIR) cannot be watched by
// anyone and is skipped. Any other failure to check an entry, list a directory or read /proc (EACCES behind a
// non-searchable directory, an unreadable /proc) means the evidence is incomplete, so unwatched() throws and the domain
// reports "unavailable" with that cause (verify-qa, o9o.38 review: a symlink to a file behind a non-searchable directory
// was skipped and the claim stayed "watching" while its edits gave no event).
import * as fs from "node:fs";
import nodePath from "node:path";
import type { SourceTreeWatch, SourceTreeWatcher } from "../domain/proof/source-watch.js";

/** Gone, not unreadable: removed since it was listed, or a symlink whose target does not exist. */
function isGone(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
function errorCode(err: unknown): string {
  return (err as NodeJS.ErrnoException | null)?.code ?? (err instanceof Error ? err.message : String(err));
}

/**
 * "major:minor:inode" for what `path` resolves to (stat follows symlinks, as inotify_add_watch does), from the userspace
 * dev_t fs.stat returns; null when the entry is gone. Throws when it cannot be checked.
 */
function statKey(path: string): string | null {
  let st: fs.BigIntStats;
  try { st = fs.statSync(path, { bigint: true }); } catch (err) {
    if (isGone(err)) return null;
    throw new Error(`could not check ${path}: ${errorCode(err)}`);
  }
  const dev = st.dev;
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
  const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
  return `${major}:${minor}:${st.ino}`;
}

/**
 * Every "major:minor:inode" this process holds an inotify watch on, from the kernel's sdev (major << 20 | minor).
 * A descriptor closed while it is read is skipped; anything else that stops the read throws.
 */
function watchedKeys(procSelf: string): Set<string> {
  const keys = new Set<string>();
  let fds: string[];
  try { fds = fs.readdirSync(nodePath.join(procSelf, "fd")); } catch (err) {
    throw new Error(`could not read this process's inotify watches from ${procSelf}: ${errorCode(err)}`);
  }
  for (const fd of fds) {
    let target: string;
    try { target = fs.readlinkSync(nodePath.join(procSelf, "fd", fd)); } catch (err) {
      if (isGone(err)) continue;
      throw new Error(`could not read ${nodePath.join(procSelf, "fd", fd)}: ${errorCode(err)}`);
    }
    if (target !== "anon_inode:inotify") continue;
    let info: string;
    try { info = fs.readFileSync(nodePath.join(procSelf, "fdinfo", fd), "utf-8"); } catch (err) {
      if (isGone(err)) continue;
      throw new Error(`could not read ${nodePath.join(procSelf, "fdinfo", fd)}: ${errorCode(err)}`);
    }
    for (const line of info.split("\n")) {
      const m = /^inotify wd:\S+ ino:([0-9a-f]+) sdev:([0-9a-f]+)/.exec(line);
      if (!m) continue;
      const sdev = BigInt(`0x${m[2]}`);
      keys.add(`${sdev >> 20n}:${sdev & 0xfffffn}:${BigInt(`0x${m[1]}`)}`);
    }
  }
  return keys;
}

/**
 * `dir` and, when recursive, every real directory and every symlink under it: what the Linux tree watch below arms (it
 * descends real directories only, never a symlinked one). A directory gone since it was listed is skipped; one that
 * cannot be listed throws.
 */
function watchedEntries(dir: string, recursive: boolean): string[] {
  const found = [dir];
  if (!recursive) return found;
  const pending = [dir];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (err) {
      if (isGone(err)) continue;
      throw new Error(`could not list ${current}: ${errorCode(err)}`);
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const path = nodePath.join(current, entry.name);
      found.push(path);
      if (entry.isDirectory()) pending.push(path);
    }
  }
  return found;
}

/**
 * workspaces-o9o.133: a recursive watch on Linux, built from one non-recursive fs.watch per real directory and per
 * symlink. An entry that cannot be armed (or whose watch reports an error) is left unwatched and a change is reported,
 * so the domain reads the evidence, which names it; nothing here throws past the caller. A directory that appears is
 * armed with its subtree, a symlink by itself; one that goes has its watches dropped, so it is armed again if it comes back.
 */
function linuxTreeWatch(root: string, onChange: (filename: string | null) => void): SourceTreeWatch {
  const watches = new Map<string, fs.FSWatcher>();
  let closed = false;
  const drop = (dir: string) => {
    for (const [path, w] of watches) {
      if (path === dir || path.startsWith(dir + nodePath.sep)) { w.close(); watches.delete(path); }
    }
  };
  const kindOf = (path: string): "directory" | "symlink" | "other" => {
    try { const st = fs.lstatSync(path); return st.isDirectory() ? "directory" : st.isSymbolicLink() ? "symlink" : "other"; } catch { return "other"; }
  };
  const arm = (dir: string) => {
    if (closed || watches.has(dir)) return;
    let w: fs.FSWatcher;
    try {
      w = fs.watch(dir, { persistent: false }, (event, filename) => {
        const name = filename === null ? null : filename.toString();
        if (name === null) { armTree(dir); onChange(null); return; }
        const child = nodePath.join(dir, name);
        if (event === "rename") {
          const kind = kindOf(child);
          if (kind === "directory") armTree(child);
          else if (kind === "symlink") arm(child);
          else drop(child);
        }
        onChange(nodePath.relative(root, child));
      });
    } catch {
      // Not armed (ENOSPC, EACCES, gone): the evidence names this directory; report a change so it is read now.
      onChange(null);
      return;
    }
    w.on("error", () => {
      // A failed watch is dropped, never thrown; the evidence then names the directory.
      w.close();
      if (watches.get(dir) === w) watches.delete(dir);
      onChange(null);
    });
    watches.set(dir, w);
  };
  const armTree = (dir: string) => {
    for (const path of watchedEntriesBestEffort(dir)) arm(path);
  };
  armTree(root);
  return { close: () => { closed = true; for (const w of watches.values()) w.close(); watches.clear(); } };
}

/** watchedEntries(dir, true) for arming: a directory that cannot be listed is still armed itself and not descended. */
function watchedEntriesBestEffort(dir: string): string[] {
  try { return watchedEntries(dir, true); } catch { return isGoneOrMissing(dir) ? [] : [dir]; }
}
function isGoneOrMissing(path: string): boolean {
  try { fs.lstatSync(path); return false; } catch (err) { return isGone(err); }
}

/** `procSelf` is where this process's /proc entries are read; tests point it elsewhere to prove a failed read fails closed. */
export function nodeSourceTreeWatcher(platform: NodeJS.Platform = process.platform, procSelf = "/proc/self"): SourceTreeWatcher {
  return {
    watch(dir, options, onChange, onError): SourceTreeWatch {
      if (platform === "linux" && options.recursive) return linuxTreeWatch(dir, onChange);
      const watcher = fs.watch(dir, { recursive: options.recursive, persistent: false }, (_event, filename) => {
        onChange(filename === null ? null : filename.toString());
      });
      watcher.on("error", onError);
      return { close: () => watcher.close() };
    },
    unwatched(dir, recursive) {
      if (platform !== "linux") return null;
      const held = watchedKeys(procSelf);
      return watchedEntries(dir, recursive).filter((entry) => {
        const key = statKey(entry);
        // An entry gone since the listing (or a dangling symlink, which cannot be watched) is not a gap.
        return key !== null && !held.has(key);
      });
    },
  };
}
