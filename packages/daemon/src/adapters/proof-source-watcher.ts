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
import * as fs from "node:fs";
import nodePath from "node:path";
import type { SourceTreeWatch, SourceTreeWatcher } from "../domain/proof/source-watch.js";

/** "major:minor:inode" for what `path` resolves to (stat follows symlinks, as inotify_add_watch does), from the userspace dev_t fs.stat returns. */
function statKey(path: string): string | null {
  let st: fs.BigIntStats;
  try { st = fs.statSync(path, { bigint: true }); } catch { return null; }
  const dev = st.dev;
  const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn);
  const minor = (dev & 0xffn) | ((dev >> 12n) & ~0xffn);
  return `${major}:${minor}:${st.ino}`;
}

/** Every "major:minor:inode" this process holds an inotify watch on, from the kernel's sdev (major << 20 | minor). */
function watchedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const fd of fs.readdirSync("/proc/self/fd")) {
    let target: string;
    try { target = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { continue; }
    if (target !== "anon_inode:inotify") continue;
    let info: string;
    try { info = fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf-8"); } catch { continue; }
    for (const line of info.split("\n")) {
      const m = /^inotify wd:\S+ ino:([0-9a-f]+) sdev:([0-9a-f]+)/.exec(line);
      if (!m) continue;
      const sdev = BigInt(`0x${m[2]}`);
      keys.add(`${sdev >> 20n}:${sdev & 0xfffffn}:${BigInt(`0x${m[1]}`)}`);
    }
  }
  return keys;
}

/** `dir` and, when recursive, every entry under it, as Node's recursive watch arms them: it descends real directories only. */
function watchedEntries(dir: string, recursive: boolean): string[] {
  const found = [dir];
  if (!recursive) return found;
  const pending = [dir];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = nodePath.join(current, entry.name);
      found.push(path);
      if (entry.isDirectory()) pending.push(path);
    }
  }
  return found;
}

export function nodeSourceTreeWatcher(platform: NodeJS.Platform = process.platform): SourceTreeWatcher {
  return {
    watch(dir, options, onChange, onError): SourceTreeWatch {
      const watcher = fs.watch(dir, { recursive: options.recursive, persistent: false }, (_event, filename) => {
        onChange(filename === null ? null : filename.toString());
      });
      watcher.on("error", onError);
      return { close: () => watcher.close() };
    },
    unwatched(dir, recursive) {
      if (platform !== "linux") return null;
      const held = watchedKeys();
      return watchedEntries(dir, recursive).filter((entry) => {
        const key = statKey(entry);
        // An entry removed between the listing and the stat (or a dangling symlink, which cannot be watched) is not a gap.
        return key !== null && !held.has(key);
      });
    },
  };
}
