import nodePath from "node:path";

// workspaces-o9o.123 / o9o.176 (verify-sec2): the one rule for writing a seat's Claude state file (`.claude.json`) — the onboarding and
// trust bootstrap and the Code Mode one-time answer both go through it. It never writes through a symbolic link: the file is written with
// O_NOFOLLOW (so a link swapped in after the check is refused too), and any directory the caller names (a seat's own Claude home) is
// refused if it is a link. A file system that cannot do either is refused. Whatever is not written is returned naming the path.
//
// o9o.176 (verify-sec2 round 2): the outcome distinguishes a GUARD REFUSAL — a DETECTED symbolic link or a wrong-typed path
// (`refused: true`, carrying the path) — from any OTHER reason the write did not land: a mutation's own warning, a thrown read/write
// error, or a file system that cannot guard at all (`refused: false`). The caller decides what each means: the bootstrap turns a refusal
// into a delivery failure that aborts the launch (OpenRig must never launch a seat whose trust state would have been written through a
// link), and keeps the other reasons as today's non-fatal warning; the Code Mode writer treats both as a non-fatal warning (the launch
// may stop at the picker). The cannot-guard case only reaches test doubles — the real adapter always wires lstat + O_NOFOLLOW (o9o.123).

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

/** The result of one guarded write. `ok` means written or a no-op. Otherwise: `refused` true is a DETECTED guard refusal (a symbolic link
 *  or a wrong-typed path) and carries the refused path, so the bootstrap can fail the launch naming the file; `refused` false is any other
 *  reason (a mutation warning, a thrown error, or a file system that cannot guard), which stays a non-fatal warning. `message` is the text. */
export type GuardedStateOutcome =
  | { ok: true }
  | { ok: false; refused: true; path: string; message: string }
  | { ok: false; refused: false; message: string };

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

/** Write `statePath` under the one rule above. Returns a structured outcome (see GuardedStateOutcome); never throws. */
export function writeGuardedClaudeState(fs: GuardedStateFs, statePath: string, opts: GuardedStateWrite): GuardedStateOutcome {
  const prefix = opts.prefix ?? "";
  const lstat = fs.lstat?.bind(fs);
  const writeNoFollow = fs.writeFileNoFollow?.bind(fs);
  if (!lstat || !writeNoFollow) {
    // A file system that cannot guard writes NOTHING (fail closed, nothing unsafe is written), but it is NOT a detected guard refusal:
    // the real adapter always wires these primitives (o9o.123), so this only reaches test doubles, and it stays a non-fatal warning as
    // before. Only an actually-detected link or wrong-typed path aborts the launch.
    return { ok: false, refused: false, message: `${prefix}${statePath} was not written: this file system cannot check for or refuse a symbolic link` };
  }
  try {
    const targets: ReadonlyArray<readonly [string, "directory" | "file"]> = [
      ...(opts.guardDirs ?? []).map((dir) => [dir, "directory"] as const),
      [statePath, "file"] as const,
    ];
    for (const [path, wanted] of targets) {
      const kind = lstat(path);
      if (kind === "symlink") return { ok: false, refused: true, path, message: `${prefix}${path} is a symbolic link, so ${opts.subject} was not written; OpenRig never writes through a link` };
      if (kind !== null && kind !== wanted) return { ok: false, refused: true, path, message: `${prefix}${path} is not a ${wanted}, so ${opts.subject} was not written` };
    }
    const state = lstat(statePath) === "file" ? fs.readJsonObject(statePath) : {};
    const result = opts.mutate(state);
    if (result.warning) return { ok: false, refused: false, message: result.warning };
    if (!result.changed) return { ok: true };
    fs.mkdirp(nodePath.dirname(statePath));
    writeNoFollow(statePath, JSON.stringify(state, null, 2));
    return { ok: true };
  } catch (err) {
    // A read/mutate/write that threw (e.g. unmergeable existing state) is NOT a guard refusal: the launch keeps going with a warning.
    return { ok: false, refused: false, message: `${prefix}${statePath} was not written: ${(err as Error).message}` };
  }
}
