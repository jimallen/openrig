// OF-31 — shared by the daemon's cwd anchor and the CLI's buildDaemonEnv so
// both launch routes (`rig daemon start`, direct `node dist/index.js`) rebase
// relative path-valued env the same way.
import path from "node:path";

/** Single-path OpenRig env vars. List-valued vars (…_ROOTS, …_ALLOWLIST) are
 * deliberately excluded: their separator syntax is not ours to rewrite. */
export const SINGLE_PATH_ENV = /^(?:OPENRIG|RIGGED)_(?:[A-Z0-9_]*_)?(?:HOME|DB|ROOT|PATH|DIR|FILE|SOCKET)$/;

/** A value that names a relative filesystem path. Empty, absolute, `~`-prefixed,
 * `:memory:` and URI-scheme values (`file:…`) are not ours to rewrite. */
export function isRelativeFilesystemPath(value: string): boolean {
  if (!value || path.isAbsolute(value) || value.startsWith("~") || value === ":memory:") return false;
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

/** `value` resolved against `base` when it is a relative filesystem path, else unchanged. */
export function rebaseRelativePath(value: string, base: string): string {
  return isRelativeFilesystemPath(value) ? path.resolve(base, value) : value;
}

/** Rebase every single-path env var in `env` against `base`, in place. */
export function rebaseRelativePathEnv(env: Record<string, string | undefined>, base: string): void {
  for (const [key, value] of Object.entries(env)) {
    if (SINGLE_PATH_ENV.test(key) && value !== undefined) env[key] = rebaseRelativePath(value, base);
  }
}
