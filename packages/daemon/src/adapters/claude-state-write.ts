import nodePath from "node:path";

// workspaces-o9o.123 / o9o.176 (verify-sec2): the one rule for writing a seat's Claude state file (`.claude.json`) — the onboarding and
// trust bootstrap and the Code Mode one-time answer both go through it. It never writes through a symbolic link: the file is written with
// O_NOFOLLOW (so a link swapped in after the check is refused too), and any directory the caller names (a seat's own Claude home) is
// refused if it is a link. A file system that cannot do either is refused. Whatever is not written is returned as a warning naming the
// path; the caller decides whether that is a launch warning (Code Mode) or a bootstrap failure.

export interface GuardedStateFs {
  /** Parse the file as a JSON object; throw on unreadable or non-object content (the caller's existing strict reader). */
  readJsonObject(path: string): Record<string, unknown>;
  mkdirp(path: string): void;
  /** What a path is WITHOUT following a link at its final component. Absent: the write is refused (fail closed). */
  lstat?(path: string): "file" | "directory" | "symlink" | "other" | null;
  /** Write without following a link at the file (O_NOFOLLOW). Absent: the write is refused (fail closed). */
  writeFileNoFollow?(path: string, content: string): void;
}

/** A mutation of the parsed state: `changed` says whether it must be written; `warning` (if set) stops the write and is returned. */
export type StateMutation = { changed: boolean; warning?: string };

export interface GuardedStateWrite {
  /** What was not written, named in the warning (e.g. "Code Mode's one-time answer", "the Claude onboarding and trust state"). */
  subject: string;
  /** Leads every warning this write returns (e.g. "code_mode: "); defaults to empty. */
  prefix?: string;
  /** Directories that must not be symbolic links (a seat's own Claude home). The file itself is always link-checked. */
  guardDirs?: readonly string[];
  /** Runs on the parsed state (or {} when the file is absent); mutate it in place and report whether it changed. */
  mutate(state: Record<string, unknown>): StateMutation;
}

/** Write `statePath` under the one rule above. Returns a warning string, or null on success or a no-op. Never throws. */
export function writeGuardedClaudeState(fs: GuardedStateFs, statePath: string, opts: GuardedStateWrite): string | null {
  const prefix = opts.prefix ?? "";
  const lstat = fs.lstat?.bind(fs);
  const writeNoFollow = fs.writeFileNoFollow?.bind(fs);
  if (!lstat || !writeNoFollow) {
    return `${prefix}${statePath} was not written: this file system cannot check for or refuse a symbolic link`;
  }
  try {
    const targets: ReadonlyArray<readonly [string, "directory" | "file"]> = [
      ...(opts.guardDirs ?? []).map((dir) => [dir, "directory"] as const),
      [statePath, "file"] as const,
    ];
    for (const [path, wanted] of targets) {
      const kind = lstat(path);
      if (kind === "symlink") return `${prefix}${path} is a symbolic link, so ${opts.subject} was not written; OpenRig never writes through a link`;
      if (kind !== null && kind !== wanted) return `${prefix}${path} is not a ${wanted}, so ${opts.subject} was not written`;
    }
    const state = lstat(statePath) === "file" ? fs.readJsonObject(statePath) : {};
    const result = opts.mutate(state);
    if (result.warning) return result.warning;
    if (!result.changed) return null;
    fs.mkdirp(nodePath.dirname(statePath));
    writeNoFollow(statePath, JSON.stringify(state, null, 2));
    return null;
  } catch (err) {
    return `${prefix}${statePath} was not written: ${(err as Error).message}`;
  }
}
