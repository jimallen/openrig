import { createHash } from "node:crypto";
import * as path from "node:path";

/**
 * OPR-fork: worktree placement as a LAW, not advice. Seats' personas say
 * "spawn scratch worktrees at <repo>/.rig-worktrees/<name>" (house doctrine);
 * this shim makes the law hold even when a seat forgets.
 *
 * The daemon materializes a 'git' shim into <OPENRIG_HOME>/rig-bin and
 * NodeLauncher prepends that dir to a seat's PATH. The shim intercepts ONLY
 * `git worktree add … <path>` whose target is outside the current repo's
 * .rig-worktrees dir (reached past git's global options, so `git -C <dir> worktree
 * add` counts, from that dir) — redirecting it in place — and forwards every other git
 * invocation byte-for-byte. The path computation happens inside the calling
 * shell's repo; the shim itself never guesses repos.
 *
 * Why a shim and not a hook: there is no git hook for `worktree add`.
 * Why daemon-owned: seats never bypass the harness env — and on the same host
 * the human's login shell PATH takes precedence over the shim (it prepends),
 * so the human keeps their own placement freedom.
 */

export const SHIM_DIR_NAME = "rig-bin";
export const SHIM_FILE_NAME = "git";

const SHIM_BODY = `#!/usr/bin/env bash
# openrig git worktree placement shim — only 'git worktree add' paths are governed.
set -euo pipefail
real_git() {
  # The first git on PATH that is not this shim. Identity is the file: -ef compares
  # device and inode after following symlinks, so a symlinked rig-bin, a file
  # symlink or a hard link to this shim is still this shim. 'type -aP' lists every
  # git on PATH (bash 3.2 and later); bash's 'command' has no -a. No git but this
  # shim: fail like a plain missing git rather than exec ourselves.
  local self p
  self="\${BASH_SOURCE[0]}"
  while IFS= read -r p; do
    [ -n "\$p" ] || continue
    if [ ! "\$p" -ef "\$self" ]; then
      printf '%s\\n' "\$p"; return 0
    fi
  done < <(type -aP git || true)
  printf '%s\\n' "git: command not found (openrig shim: no git on PATH other than \$self)" >&2
  return 127
}
real="\$(real_git)" || exit \$?
# Reach the subcommand past git's global options (git 2.43.0 and 2.55.0: 'git -h', 'git help git').
# -C and -c take only the next word; the others that take a value also take '=value'. Each -C
# moves from the one before ('' does nothing), so a relative path resolves from base, as in git.
# --git-dir, --work-tree and --bare move what git calls the toplevel, and an option not listed
# here is never guessed at: either one stops the scan and the call goes through unchanged,
# saying so only when it goes on to 'worktree add'.
words=("\$@"); n=\$#; s=0; base=""; held=""; heldword=""
while [ "\$s" -lt "\$n" ]; do
  a="\${words[\$s]}"
  case "\$a" in
    -C)
      [ \$((s+1)) -lt "\$n" ] || break
      d="\${words[\$((s+1))]}"
      # cd reads a bare '-' as \$OLDPWD; git reads it as a directory named '-'. The physical dir is printed
      # with a '/' sentinel, since \$(...) strips a trailing newline that may be part of the name.
      case "\$d" in -) d="./-" ;; esac
      if [ -n "\$d" ]; then
        base="\$(unset CDPATH; cd -P -- "\${base:-.}" 2>/dev/null && cd -P -- "\$d" 2>/dev/null && printf '%s/' "\$PWD")" || exec "\$real" "\$@"
        base="\${base%/}"
      fi
      s=\$((s+2)) ;;
    -c|--namespace|--config-env|--attr-source) s=\$((s+2)) ;;
    --namespace=*|--config-env=*|--attr-source=*|--exec-path=*|-p|--paginate|-P|--no-pager|\\
    --no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|\\
    --no-optional-locks|--no-lazy-fetch|--no-advice)
      s=\$((s+1)) ;;
    --git-dir|--git-dir=*|--work-tree|--work-tree=*|--bare) held="global option"; heldword="\${a%%=*}"; break ;;
    -v|--version|-h|--help|--exec-path|--html-path|--man-path|--info-path|--list-cmds=*) exec "\$real" "\$@" ;;
    -*) held="unrecognised option"; heldword="\$a"; break ;;
    *) break ;;
  esac
done
if [ -n "\$held" ]; then
  j=\$s
  while [ \$((j+1)) -lt "\$n" ]; do
    if [ "\${words[\$j]}" = "worktree" ] && [ "\${words[\$((j+1))]}" = "add" ]; then
      # %q: a newline or a control character in the word stays on this one line, quoted.
      printf 'openrig git shim: worktree path not checked (%s %q)\\n' "\$held" "\$heldword" >&2
      break
    fi
    j=\$((j+1))
  done
  exec "\$real" "\$@"
fi
if [ \$((s+2)) -le "\$n" ] && [ "\${words[\$s]}" = "worktree" ] && [ "\${words[\$((s+1))]}" = "add" ]; then
  # Find the <path> word by git 2.43.0's grammar ('git worktree add -h'); every other
  # word reaches git unchanged. -b, -B and --reason take the next word as a value.
  # An option not listed here (an abbreviation, a cluster, a newer git's option) is
  # never guessed at: the call goes through unredirected, with one line saying so.
  i=\$((s+2)); pathi=""; unknown=""
  while [ "\$i" -lt "\$n" ]; do
    a="\${words[\$i]}"
    case "\$a" in
      --) if [ \$((i+1)) -lt "\$n" ]; then pathi=\$((i+1)); fi; break ;;
      -b|-B|--reason) i=\$((i+2)) ;;
      -b?*|-B?*|--reason=*) i=\$((i+1)) ;;
      -f|--force|--no-force|-d|--detach|--no-detach|-q|--quiet|--no-quiet|--orphan|--no-orphan|\\
      --checkout|--no-checkout|--lock|--no-lock|--no-reason|--track|--no-track|--guess-remote|--no-guess-remote)
        i=\$((i+1)) ;;
      -?*) unknown="\$a"; break ;;
      *) pathi=\$i; break ;;
    esac
  done
  if [ -n "\$unknown" ]; then
    # %q: a newline or a control character in the word stays on this one line, quoted.
    printf 'openrig git shim: worktree path not checked (unrecognised option %q)\\n' "\$unknown" >&2
    exec "\$real" "\$@"
  fi
  target="\${pathi:+\${words[\$pathi]}}"
  # rev-parse ends its line with a newline and the toplevel's own name may end in one: a '/' sentinel keeps
  # both from \$(...)'s stripping, then exactly the one rev-parse added is removed.
  toplevel="\$({ cd -P -- "\${base:-.}" && "\$real" rev-parse --show-toplevel 2>/dev/null && printf /; } || true)"
  toplevel="\${toplevel%/}"; toplevel="\${toplevel%\$'\\n'}"
  if [ -n "\$target" ] && [ -n "\$toplevel" ]; then
    # Inside is judged on the PHYSICAL path, not its text: the deepest ancestor that exists is
    # resolved with cd -P, the rest is taken by name. A '..' in the part that does not exist yet
    # counts as outside. (A dangling symlink there is no way out: git fails to create through it,
    # measured on 2.43.0.) The target never goes through \$(...),
    # which strips a trailing newline; the resolved ancestor is printed with a '/' sentinel.
    case "\$target" in /*) p="\$target" ;; *) p="\${base:-\$(pwd -P)}/\$target" ;; esac
    rest=""; inside=yes
    while [ -n "\$p" ] && [ ! -d "\$p" ]; do
      c="\${p##*/}"
      case "\$c" in
        ..) inside=no; break ;;
        .|"") ;;
        *) rest="/\$c\$rest" ;;
      esac
      p="\${p%/*}"
    done
    if [ "\$inside" = yes ]; then
      head="\$(cd -P -- "\${p:-/}" 2>/dev/null && printf '%s/' "\$PWD")" || inside=no
      [[ "\${head%/}\$rest" == "\$toplevel/.rig-worktrees/"?* ]] || inside=no
    fi
    if [ "\$inside" = no ]; then
      # Redirect by the path's last name (basename, without \$(...)). A name that is not a
      # directory inside .rig-worktrees ('', '.', '..', or a symlink already there) is refused,
      # and so is every redirect while .rig-worktrees itself is a symlink or not a directory:
      # mkdir -p and git would both follow it, and nothing is ever made through it.
      name="\$target"
      while [ "\${#name}" -gt 1 ] && [ "\${name%/}" != "\$name" ]; do name="\${name%/}"; done
      name="\${name##*/}"
      dest="\$toplevel/.rig-worktrees/\$name"
      case "\$name" in ""|.|..) dest="" ;; esac
      if [ -L "\$toplevel/.rig-worktrees" ] || { [ -e "\$toplevel/.rig-worktrees" ] && [ ! -d "\$toplevel/.rig-worktrees" ]; }; then
        dest=""
      fi
      if [ -z "\$dest" ] || [ -L "\$dest" ]; then
        printf 'openrig git shim: refusing worktree path %q (it does not name a directory inside %q)\\n' "\$target" "\$toplevel/.rig-worktrees" >&2
        exit 128
      fi
      words[\$pathi]="\$dest"
      mkdir -p "\$toplevel/.rig-worktrees"
      exec "\$real" "\${words[@]}"
    fi
  fi
fi
exec "\$real" "\$@"
`;

export function shimPath(openrigHome: string): string {
  return path.join(openrigHome, SHIM_DIR_NAME, SHIM_FILE_NAME);
}

export function shimDir(openrigHome: string): string {
  return path.join(openrigHome, SHIM_DIR_NAME);
}

const SHIM_MODE = 0o755;

/** What one refresh of <OPENRIG_HOME>/rig-bin/git did. Hashes are sha256 hex. */
export type ShimRefresh =
  | { kind: "created"; path: string; sha256: string }
  | { kind: "replaced"; path: string; fromSha256: string; toSha256: string }
  | { kind: "mode-fixed"; path: string; fromMode: number; toMode: number }
  | { kind: "unchanged"; path: string; sha256: string }
  | { kind: "refused"; path: string; reason: string };

/** What sits at a path, seen without following a symlink. */
export type ShimEntry = "file" | "directory" | "symlink" | "other" | "absent";

/**
 * The port: the file effects a shim refresh needs, in the shim's own words. The domain decides what to do; the adapter
 * (src/adapters/node-shim-files.ts, wired in startup.ts) does it. Every operation is on one name and never follows a
 * symlink at that name.
 */
export interface ShimFiles {
  /** What is at this path (lstat), or "absent". */
  entryAt(p: string): Promise<ShimEntry>;
  /** Create this folder, and any missing parents. */
  makeFolder(p: string): Promise<void>;
  /** The bytes and permission bits (mode & 0o777) of the regular file at this path, refusing a symlink at the name. */
  readShim(p: string): Promise<{ body: Uint8Array; mode: number }>;
  /**
   * Put body at file with exactly this mode, atomically: a fresh temp in folder (never an existing name), its mode set
   * (not left to the umask), renamed over file (rename replaces the name, never a link's target). On any failure the
   * temp is removed and file is left as it was.
   */
  writeAtomically(folder: string, file: string, body: string, mode: number): Promise<void>;
}

const sha256 = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");

/**
 * Make <OPENRIG_HOME>/rig-bin/git the package's shim, byte for byte and mode 0755, and say what that took. Called at
 * daemon start (so a deploy reaches running seats, which exec this file on every git call) and at every seat launch.
 *
 * Never through a symlink: rig-bin or rig-bin/git being a symlink (or not a directory / not a regular file) refuses the
 * refresh and nothing is written. The current file is read without following a link, and a write is atomic
 * (ShimFiles.writeAtomically), so a seat mid-exec never sees a torn script. OPENRIG_HOME itself is not checked, the same
 * anchor rule as the openrig-core refresh. Residual, the one o9o.17 accepted on 2026-11-16 by OpenRig's 15-minute
 * auto-answer (the question to Jim went unanswered, so OpenRig took its Recommended option, "Accept the residual", at
 * 18:21Z; queue record qa-f5c084b1679e94516e44aff1e88a8361), which counts as Jim's go under his 2026-11-08 rule: rig-bin
 * swapped for a symlink between the check and the mkdir, open or rename that follows; Node has no openat or renameat on
 * a folder handle, and it takes a concurrent process of the same user that could write the shim directly.
 */
export async function refreshGitWorktreeShim(openrigHome: string, files: ShimFiles): Promise<ShimRefresh> {
  const dir = shimDir(openrigHome);
  const file = shimPath(openrigHome);
  const dirEntry = await files.entryAt(dir);
  if (dirEntry === "symlink") return { kind: "refused", path: file, reason: `${dir} is a symlink` };
  if (dirEntry !== "absent" && dirEntry !== "directory") return { kind: "refused", path: file, reason: `${dir} is not a directory` };
  if (dirEntry === "absent") await files.makeFolder(dir);

  const fileEntry = await files.entryAt(file);
  if (fileEntry === "symlink") return { kind: "refused", path: file, reason: `${file} is a symlink` };
  if (fileEntry !== "absent" && fileEntry !== "file") return { kind: "refused", path: file, reason: `${file} is not a regular file` };

  const current = fileEntry === "file" ? await files.readShim(file) : null;
  const want = sha256(SHIM_BODY);
  const have = current ? sha256(current.body) : null;
  if (current && have === want) {
    if (current.mode === SHIM_MODE) return { kind: "unchanged", path: file, sha256: want };
    await files.writeAtomically(dir, file, SHIM_BODY, SHIM_MODE);
    return { kind: "mode-fixed", path: file, fromMode: current.mode, toMode: SHIM_MODE };
  }
  await files.writeAtomically(dir, file, SHIM_BODY, SHIM_MODE);
  return have !== null
    ? { kind: "replaced", path: file, fromSha256: have, toSha256: want }
    : { kind: "created", path: file, sha256: want };
}

/** One log line for a refresh; the caller picks the stream (a refusal is an error). */
export function describeShimRefresh(r: ShimRefresh): string {
  const short = (h: string) => h.slice(0, 12);
  const octal = (m: number) => m.toString(8).padStart(4, "0");
  switch (r.kind) {
    case "created": return `git worktree shim: created ${r.path} (sha256 ${short(r.sha256)})`;
    case "replaced": return `git worktree shim: replaced ${r.path} (sha256 ${short(r.fromSha256)} -> ${short(r.toSha256)})`;
    case "mode-fixed": return `git worktree shim: mode-fixed ${r.path} (${octal(r.fromMode)} -> ${octal(r.toMode)})`;
    case "unchanged": return `git worktree shim: unchanged ${r.path} (sha256 ${short(r.sha256)})`;
    case "refused": return `git worktree shim: refused ${r.path}: ${r.reason}`;
  }
}

/**
 * The seat-launch form: refresh, and throw on a refusal so the launch goes ahead without the shim on PATH (the
 * launcher's warning says so). Returns the rig-bin dir.
 */
export async function ensureGitWorktreeShim(openrigHome: string, files: ShimFiles): Promise<string> {
  const r = await refreshGitWorktreeShim(openrigHome, files);
  if (r.kind === "refused") throw new Error(describeShimRefresh(r));
  return shimDir(openrigHome);
}

/** Seat PATH: shim first. Inert when the caller's PATH is absent (tests). */
export function withWorktreeShimPath(env: Record<string, string>, openrigHome: string): void {
  if (typeof env.PATH === "string") {
    env.PATH = shimDir(openrigHome) + path.delimiter + env.PATH;
  }
}

// Exposed to tests only.
export function __shimSource(): string { return SHIM_BODY; }
