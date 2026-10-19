// OF-31 — the daemon must not depend on the directory it was launched from.
// `rig daemon start` (or a direct `node dist/index.js`) inherits the caller's
// cwd; when that directory is later deleted every child the daemon spawns
// without an explicit cwd (Codex profile preflight, `codex --help`, git, tmux,
// ...) dies in the shell with "getcwd: cannot access parent directories".
// One anchor at process start covers all of those spawn sites at once.
//
// This module is imported FIRST by index.ts so it runs before sibling modules
// evaluate path constants (OPENRIG_HOME etc.) against process.env/cwd.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Single-path OpenRig env vars. List-valued vars (…_ROOTS, …_ALLOWLIST) are
 * deliberately excluded: their separator syntax is not ours to rewrite. */
const SINGLE_PATH_ENV = /^(?:OPENRIG|RIGGED)_(?:[A-Z0-9_]*_)?(?:HOME|DB|ROOT|PATH|DIR|FILE|SOCKET)$/;

export interface CwdAnchorDeps {
  cwd: () => string;
  chdir: (dir: string) => void;
  home: () => string;
}

/**
 * Make relative single-path env values absolute against the launch cwd (their
 * meaning so far), then move the process to a directory that cannot vanish
 * under a running daemon. Returns the directory chosen.
 */
export function anchorDaemonCwd(
  env: NodeJS.ProcessEnv = process.env,
  deps: CwdAnchorDeps = { cwd: () => process.cwd(), chdir: (d) => process.chdir(d), home: homedir },
): string {
  let launchCwd: string | null = null;
  try { launchCwd = deps.cwd(); } catch { /* already deleted: nothing relative can be honoured */ }
  for (const [key, value] of Object.entries(env)) {
    if (!SINGLE_PATH_ENV.test(key) || !value || path.isAbsolute(value) || launchCwd === null) continue;
    env[key] = path.resolve(launchCwd, value);
  }
  const target = deps.home();
  deps.chdir(target);
  return target;
}

function isDirectDaemonEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const here = path.dirname(fileURLToPath(import.meta.url));
  try {
    const real = realpathSync(entry);
    return [".js", ".ts"].some((ext) => {
      try { return realpathSync(path.join(here, `index${ext}`)) === real; } catch { return false; }
    });
  } catch { return false; }
}

if (isDirectDaemonEntry()) anchorDaemonCwd();
