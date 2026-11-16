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
 * .rig-worktrees dir — redirecting it in place — and forwards every other git
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
if [ "\$#" -ge 2 ] && [ "\$1" = "worktree" ] && [ "\$2" = "add" ]; then
  # Find the <path> word by git 2.43.0's grammar ('git worktree add -h'); every other
  # word reaches git unchanged. -b, -B and --reason take the next word as a value.
  # An option not listed here (an abbreviation, a cluster, a newer git's option) is
  # never guessed at: the call goes through unredirected, with one line saying so.
  words=("\$@"); n=\$#; i=2; pathi=""; unknown=""
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
    printf '%s\\n' "openrig git shim: worktree path not checked (unrecognised option \$unknown)" >&2
    exec "\$real" "\$@"
  fi
  target="\${pathi:+\${words[\$pathi]}}"
  toplevel="\$("\$real" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "\$target" ] && [ -n "\$toplevel" ]; then
    case "\$target" in /*) abs="\$target" ;; *) abs="\$(pwd -P)/\$target" ;; esac
    while [[ "\$abs" == */./* ]]; do abs="\${abs%%/./*}/\${abs#*/./}"; done
    if [[ "\$abs" != "\$toplevel/.rig-worktrees/"* ]]; then
      words[\$pathi]="\$toplevel/.rig-worktrees/\$(basename -- "\$target")"
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
