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
  # first git NOT this shim
  local self; self="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)'"/${SHIM_FILE_NAME}"'"
  local p; for p in \$(command -v -a git); do
    if [ "\$(cd "\$(dirname "\$p")" 2>/dev/null && pwd)/git" != "\$self" ]; then
      printf '%s\n' "\$p"; return 0
    fi
  done
  command -v /usr/bin/git || command -v git
}
if [ "\$#" -ge 1 ] && [ "\$1" = "worktree" ] && [ "\$2" = "add" ]; then
  # parse: git worktree add [-f] [-b branch] <path> [commit-ish]
  args=(); i=2
  while [ \$i -lt \$# ]; do
    a="\${@:\$((i+1)):1}"
    case "\$a" in
      -f|--force|-q|--quiet|--no-track|-d|--detach|--lock|--orphan) i=\$((i+1)) ;;
      -b|-B|--track|--guess-remote) i=\$((i+2)) ;;
      *) args+=("\$a"); i=\$((i+1)) ;;
    esac
  done
  target="\${args[0]}"
  toplevel="\$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -z "\$toplevel" ]; then exec "\$(real_git)" "\$@"; fi
  if [ -n "\$target" ] && [[ "\$target" != "\$toplevel/.rig-worktrees"/* ]]; then
    args[0]="\$toplevel/.rig-worktrees/\$(basename "\$target")"
    mkdir -p "\$toplevel/.rig-worktrees"
    exec "\$(real_git)" worktree add "\${args[@]}"
  fi
fi
exec "\$(real_git)" "\$@"
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
