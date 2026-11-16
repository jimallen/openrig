import { promises as fs } from "node:fs";
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

/**
 * Idempotently write the shim. Content-matched writes only — a running seat
 * mid-launch never sees a torn script.
 */
export async function ensureGitWorktreeShim(openrigHome: string): Promise<string> {
  const dir = shimDir(openrigHome);
  const file = shimPath(openrigHome);
  await fs.mkdir(dir, { recursive: true });
  try {
    const current = await fs.readFile(file, "utf8");
    if (current === SHIM_BODY) return dir;
  } catch {
    // absent — write below
  }
  const tmp = file + ".tmp-" + process.pid;
  await fs.writeFile(tmp, SHIM_BODY, { mode: 0o755 });
  await fs.rename(tmp, file);
  return dir;
}

/** Seat PATH: shim first. Inert when the caller's PATH is absent (tests). */
export function withWorktreeShimPath(env: Record<string, string>, openrigHome: string): void {
  if (typeof env.PATH === "string") {
    env.PATH = shimDir(openrigHome) + path.delimiter + env.PATH;
  }
}

// Exposed to tests only.
export function __shimSource(): string { return SHIM_BODY; }
